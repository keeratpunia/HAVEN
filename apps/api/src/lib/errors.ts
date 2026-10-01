/**
 * Generic error handling foundation (SDD §12.1, §17.2). Only the infra-level codes
 * are defined here (VALIDATION_FAILED, NOT_FOUND, INTERNAL). Business error codes
 * (AUTH_REQUIRED, GATE_TOKEN_EXPIRED, rule-deny codes, ...) belong to the feature
 * module that owns them and are added when that module is built — do not pre-declare
 * the full SDD §12.2 table here speculatively.
 */
export type InfraErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INTERNAL';

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    httpStatus: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** The response envelope shape from SDD §12.1 — every error response uses this shape. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

export function toErrorEnvelope(err: AppError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
      requestId,
    },
  };
}
