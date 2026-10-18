import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import type { UserPrincipal } from '../auth/principal.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The hostel named by `X-Hostel-Id` on a /v1/admin request (SDD §12.1). */
    hostelId: string;
  }
}

const HostelHeader = z.string().uuid();

/**
 * preHandler for every /v1/admin route: a signed-in user plus a well-formed
 * `X-Hostel-Id` (SDD §12.1: "staff endpoints under /v1/admin require X-Hostel-Id; the
 * policy checks the caller holds a role there"). It does not decide access — each
 * handler calls `authorize(principal, action, { hostelId })`, and a caller with no role
 * in that hostel gets 403 FORBIDDEN (TC-SEC-04).
 */
export async function staffScope(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.principal) throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
  if (request.principal.type !== 'user') {
    throw new AppError('FORBIDDEN', 403, "You don't have permission to do that.");
  }
  const raw = request.headers['x-hostel-id'];
  const parsed = HostelHeader.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'An X-Hostel-Id header (a UUID) is required.', {
      issues: [{ path: ['headers', 'x-hostel-id'], message: 'Required UUID' }],
    });
  }
  request.hostelId = parsed.data;
}

export function staffUser(request: FastifyRequest): UserPrincipal {
  const p = request.principal;
  if (!p || p.type !== 'user') throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
  return p;
}

/** A record outside the scoped hostel is "not visible to caller" (SDD §12.2). */
export function assertInHostel(recordHostelId: string | null | undefined, hostelId: string): void {
  if (recordHostelId !== hostelId) throw new AppError('NOT_FOUND', 404, 'Not found.');
}
