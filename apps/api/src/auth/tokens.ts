import type { Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { signAccessToken, type RoleGrant } from './jwt.js';
import { createSession } from './sessions.js';

export interface IssuedTokens {
  accessToken: string;
  expiresAt: string;
  refreshToken: string;
  sessionId: string;
}

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Issues a fresh session + access/refresh token pair for a newly-authenticated principal. */
export async function issueTokensForUser(
  trx: Transaction<Database>,
  params: {
    userId: string;
    roles: RoleGrant[];
    client: 'web' | 'native';
    userAgent: string | null;
    ip: string | null;
  },
  jwtSecretBase64: string,
  clock: Clock,
): Promise<IssuedTokens> {
  const session = await createSession(
    trx,
    {
      principalType: 'user',
      principalId: params.userId,
      client: params.client,
      userAgent: params.userAgent,
      ip: params.ip,
    },
    clock,
  );
  const accessToken = await signAccessToken(
    { sub: params.userId, typ: 'user', sid: session.sessionId, roles: params.roles },
    jwtSecretBase64,
  );
  return {
    accessToken,
    expiresAt: new Date(clock.now().getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    refreshToken: session.refreshToken,
    sessionId: session.sessionId,
  };
}

export async function issueTokensForVisitor(
  trx: Transaction<Database>,
  params: {
    visitorId: string;
    client: 'web' | 'native';
    userAgent: string | null;
    ip: string | null;
  },
  jwtSecretBase64: string,
  clock: Clock,
): Promise<IssuedTokens> {
  const session = await createSession(
    trx,
    {
      principalType: 'visitor',
      principalId: params.visitorId,
      client: params.client,
      userAgent: params.userAgent,
      ip: params.ip,
    },
    clock,
  );
  const accessToken = await signAccessToken(
    { sub: params.visitorId, typ: 'visitor', sid: session.sessionId, roles: [] },
    jwtSecretBase64,
  );
  return {
    accessToken,
    expiresAt: new Date(clock.now().getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
    refreshToken: session.refreshToken,
    sessionId: session.sessionId,
  };
}
