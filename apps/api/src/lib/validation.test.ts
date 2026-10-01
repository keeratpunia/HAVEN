import Fastify, { type FastifyError } from 'fastify';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AppError, toErrorEnvelope } from './errors.js';
import { generateRequestId } from './request-id.js';
import {
  configureZodValidation,
  extractZodValidationIssues,
  type ZodTypeProvider,
} from './validation.js';

const BodySchema = z.object({
  name: z.string().min(2).max(80),
  phone: z.string().regex(/^\+91[6-9][0-9]{9}$/, 'Must be a valid Indian E.164 number'),
});

/** A minimal throwaway app proving the Zod wiring — not a real feature route. */
function buildTestApp() {
  const app = Fastify({ genReqId: () => generateRequestId() });
  configureZodValidation(app);
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      reply.status(err.httpStatus).send(toErrorEnvelope(err, request.id));
      return;
    }
    const issues = extractZodValidationIssues(err);
    if (issues) {
      const validationError = new AppError('VALIDATION_FAILED', 400, 'Request validation failed', {
        issues,
      });
      reply.status(400).send(toErrorEnvelope(validationError, request.id));
      return;
    }
    reply.status(500).send({ error: { code: 'INTERNAL', message: 'test harness error' } });
  });

  app
    .withTypeProvider<ZodTypeProvider>()
    .post('/example', { schema: { body: BodySchema } }, async (request) => ({
      received: request.body,
    }));
  return app;
}

describe('Zod validation wiring (SDD §8.4, §12.2 VALIDATION_FAILED)', () => {
  it('passes a valid body through to the handler untouched', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/example',
      payload: { name: 'Priya', phone: '+919812345678' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().received).toEqual({ name: 'Priya', phone: '+919812345678' });
    await app.close();
  });

  it('rejects an invalid body with 400 VALIDATION_FAILED and a details.issues array', async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/example',
      payload: { name: 'P', phone: 'not-a-phone' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.requestId).toMatch(/^req_/);
    expect(Array.isArray(body.error.details.issues)).toBe(true);
    expect(body.error.details.issues.length).toBeGreaterThanOrEqual(2);
    const paths = body.error.details.issues.map((i: { path: unknown[] }) => i.path.join('.'));
    expect(paths).toContain('name');
    expect(paths).toContain('phone');
    await app.close();
  });

  it('rejects a missing required field', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/example', payload: { name: 'Priya' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });

  it('never leaks a stack trace in the validation error response', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/example', payload: {} });
    expect(JSON.stringify(res.json())).not.toMatch(/at .*\.(ts|js):\d+/);
    await app.close();
  });
});
