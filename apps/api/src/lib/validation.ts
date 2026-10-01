import type { FastifyError, FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Wires Zod as Fastify's schema validator/serializer (SDD §8.4: "Zod (+
 * `fastify-type-provider-zod`)"). Every future route declares
 * `{ schema: { body: MyZodSchema, querystring: ..., params: ... } }` and gets
 * automatic 400 `VALIDATION_FAILED` responses (via the error handler in `app.ts`) for
 * free — no feature module hand-rolls its own `schema.safeParse()` + manual error
 * response. Call once, before registering any route.
 */
export function configureZodValidation(app: FastifyInstance): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
}

export type { ZodTypeProvider };

/** The shape of the `details.issues` field in a `VALIDATION_FAILED` error (SDD §12.2). */
export interface ValidationIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Extracts Zod's issue list from a validation failure for the `VALIDATION_FAILED`
 * error envelope — returns `null` if this isn't a Zod validation error (callers fall
 * through to generic error handling).
 */
export function extractZodValidationIssues(err: FastifyError): ValidationIssue[] | null {
  if (!hasZodFastifySchemaValidationErrors(err)) return null;
  return err.validation.map((issue) => {
    const zodIssue = issue.params?.issue as
      { path?: (string | number)[]; message?: string } | undefined;
    return {
      path:
        zodIssue?.path ?? (issue.instancePath ? issue.instancePath.split('/').filter(Boolean) : []),
      message: zodIssue?.message ?? issue.message ?? 'Invalid value',
    };
  });
}
