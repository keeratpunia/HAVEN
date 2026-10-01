import { OAuth2Client } from 'google-auth-library';
import { AppError } from '../lib/errors.js';

/**
 * Google ID token verification (SDD §9.5). This is the "external provider requiring
 * credentials not available locally" boundary: there is no real Google OAuth client
 * secret in this sandbox, and there must never be a hardcoded fake one pretending to
 * be production config.
 *
 * The integration boundary is this interface — one real implementation that calls
 * Google over the network (used in every real environment, including local dev against
 * a real Google Cloud project if `GOOGLE_CLIENT_IDS` is configured), and tests inject a
 * fake that returns canned verified/rejected results without any network call or real
 * credential. The service layer (`google-service.ts`) only ever depends on this
 * interface, never on `google-auth-library` directly.
 */
export interface VerifiedGoogleIdToken {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export interface GoogleIdTokenVerifier {
  verify(idToken: string): Promise<VerifiedGoogleIdToken>;
}

/** Real implementation — verifies against Google's servers via `google-auth-library`. */
export class RealGoogleIdTokenVerifier implements GoogleIdTokenVerifier {
  constructor(private readonly allowedClientIds: string[]) {}

  async verify(idToken: string): Promise<VerifiedGoogleIdToken> {
    const client = new OAuth2Client();
    let ticket;
    try {
      ticket = await client.verifyIdToken({ idToken, audience: this.allowedClientIds });
    } catch {
      throw new AppError('AUTH_REQUIRED', 401, 'Invalid Google sign-in token.');
    }
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new AppError('AUTH_REQUIRED', 401, 'Invalid Google sign-in token.');
    }
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: payload.name ?? payload.email,
    };
  }
}

/**
 * Test/dev double — returns a fixed, caller-supplied result for any token equal to
 * `token`, and rejects everything else. Never used in production (nothing wires it up
 * outside tests).
 */
export class FakeGoogleIdTokenVerifier implements GoogleIdTokenVerifier {
  constructor(private readonly tokens: Map<string, VerifiedGoogleIdToken>) {}

  static withOne(token: string, result: VerifiedGoogleIdToken): FakeGoogleIdTokenVerifier {
    return new FakeGoogleIdTokenVerifier(new Map([[token, result]]));
  }

  verify(idToken: string): Promise<VerifiedGoogleIdToken> {
    const result = this.tokens.get(idToken);
    if (!result) {
      return Promise.reject(new AppError('AUTH_REQUIRED', 401, 'Invalid Google sign-in token.'));
    }
    return Promise.resolve(result);
  }
}
