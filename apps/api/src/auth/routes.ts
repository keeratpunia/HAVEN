import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Env } from '../config.js';
import type { Clock } from '../lib/clock.js';
import { withTx } from '../lib/tx.js';
import { AppError } from '../lib/errors.js';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from '../lib/cookies.js';
import { normalizePhone } from './phone.js';
import { requestOtp, verifyOtp } from './otp-service.js';
import { findOrCreateVisitorByPhone } from './visitor-service.js';
import { signInWithGoogle, getResidentStatus } from './google-service.js';
import { devLogin } from './dev-login.js';
import { issueTokensForUser, issueTokensForVisitor, type IssuedTokens } from './tokens.js';
import { rotateRefreshToken, revokeSession } from './sessions.js';
import { loadUserRoles } from './principal-loader.js';
import { signAccessToken } from './jwt.js';
import type { GoogleIdTokenVerifier } from './google.js';
import { claimInvite } from './invites.js';
import { requireAuth } from './authenticate.js';
import { authorize } from './policy.js';
import { registerAuthPolicies } from './policy-rules.js';
import { storeVisitorProfilePhoto, type MediaStorage } from '../gate/media.js';

export interface AuthRoutesOptions {
  env: Env;
  db: Kysely<Database>;
  clock: Clock;
  googleVerifier: GoogleIdTokenVerifier;
  mediaStorage: MediaStorage;
}

const PhoneSchema = z.string().min(1);
const OtpPurposeSchema = z.enum(['guest_login', 'phone_verify']);

const OtpRequestBody = z.object({ phone: PhoneSchema, purpose: OtpPurposeSchema });
const OtpVerifyBody = z.object({
  phone: PhoneSchema,
  code: z.string().length(6),
  purpose: OtpPurposeSchema,
});
const GoogleSignInBody = z.object({
  idToken: z.string().min(1),
  staffInviteToken: z.string().min(1).optional(),
});
const DevLoginBody = z.object({ email: z.string().email() });
const RefreshBody = z.object({ refreshToken: z.string().min(1).optional() });
const InviteClaimParams = z.object({ token: z.string().min(1) });

const PatchMeBody = z.object({
  fullName: z.string().min(2).max(80).optional(),
  gender: z.enum(['male', 'female', 'undisclosed']).optional(),
  isAdultConfirmed: z.literal(true).optional(),
});

function clientFromHeader(request: FastifyRequest): 'web' | 'native' {
  return request.headers['x-client'] === 'native' ? 'native' : 'web';
}

function requestIp(request: FastifyRequest): string | null {
  return request.ip ?? null;
}

function sendTokens(
  request: FastifyRequest,
  reply: FastifyReply,
  env: Env,
  tokens: IssuedTokens,
  extra: Record<string, unknown>,
): void {
  const client = clientFromHeader(request);
  if (client === 'native') {
    reply.send({
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      refreshToken: tokens.refreshToken,
      ...extra,
    });
    return;
  }
  reply
    .setCookie(REFRESH_COOKIE_NAME, tokens.refreshToken, refreshCookieOptions(env))
    .send({ accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, ...extra });
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  registerAuthPolicies();
  const { env, db, clock, googleVerifier } = opts;
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.post('/auth/otp/request', { schema: { body: OtpRequestBody } }, async (request, reply) => {
    const phone = normalizePhone(request.body.phone);
    const result = await requestOtp(
      db,
      { phone, purpose: request.body.purpose, ip: requestIp(request) },
      env,
      clock,
    );
    reply.status(202).send(result);
  });

  api.post('/auth/otp/verify', { schema: { body: OtpVerifyBody } }, async (request, reply) => {
    const phone = normalizePhone(request.body.phone);
    const { purpose, code } = request.body;

    if (purpose === 'phone_verify') {
      if (!request.principal || request.principal.type !== 'user') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
      }
      const userId = request.principal.userId;
      await verifyOtp(db, { phone, code, purpose }, env, clock);
      await withTx(db, { principal: request.principal, requestId: request.id }, async (trx) => {
        await trx
          .updateTable('haven.users')
          .set({ phone, phone_verified_at: clock.now().toISOString() })
          .where('id', '=', userId)
          .execute();
      });
      reply.status(200).send({ phoneVerified: true });
      return;
    }

    await verifyOtp(db, { phone, code, purpose }, env, clock);
    const tokens = await withTx(db, { principal: null, requestId: request.id }, async (trx) => {
      const visitor = await findOrCreateVisitorByPhone(trx, phone, clock);
      const issued = await issueTokensForVisitor(
        trx,
        {
          visitorId: visitor.visitorId,
          client: clientFromHeader(request),
          userAgent: request.headers['user-agent'] ?? null,
          ip: requestIp(request),
        },
        env.JWT_SECRET,
        clock,
      );
      return { issued, visitor };
    });

    sendTokens(request, reply, env, tokens.issued, {
      principal: {
        type: 'visitor',
        id: tokens.visitor.visitorId,
        profileComplete: tokens.visitor.profileComplete,
      },
    });
  });

  api.post('/auth/google', { schema: { body: GoogleSignInBody } }, async (request, reply) => {
    const result = await withTx(db, { principal: null, requestId: request.id }, async (trx) => {
      const signIn = await signInWithGoogle(trx, googleVerifier, clock, {
        idToken: request.body.idToken,
        staffInviteToken: request.body.staffInviteToken,
      });
      const residentStatus = await getResidentStatus(trx, signIn.userId);
      const issued = await issueTokensForUser(
        trx,
        {
          userId: signIn.userId,
          roles: signIn.roles,
          client: clientFromHeader(request),
          userAgent: request.headers['user-agent'] ?? null,
          ip: requestIp(request),
        },
        env.JWT_SECRET,
        clock,
      );
      return { issued, signIn, residentStatus };
    });

    sendTokens(request, reply, env, result.issued, {
      principal: {
        type: 'user',
        id: result.signIn.userId,
        roles: result.signIn.roles,
        residentStatus: result.residentStatus,
      },
    });
  });

  // Dev-only resident/staff sign-in bypass (DEC-011) — registered only when enabled;
  // `buildApp` has already refused to boot with this flag on outside NODE_ENV=development.
  if (env.DEV_LOGIN_ENABLED) {
    api.post('/auth/dev-login', { schema: { body: DevLoginBody } }, async (request, reply) => {
      const result = await withTx(db, { principal: null, requestId: request.id }, async (trx) => {
        const signIn = await devLogin(trx, clock, request.body.email);
        const residentStatus = await getResidentStatus(trx, signIn.userId);
        const issued = await issueTokensForUser(
          trx,
          {
            userId: signIn.userId,
            roles: signIn.roles,
            client: clientFromHeader(request),
            userAgent: request.headers['user-agent'] ?? null,
            ip: requestIp(request),
          },
          env.JWT_SECRET,
          clock,
        );
        return { issued, signIn, residentStatus };
      });

      sendTokens(request, reply, env, result.issued, {
        principal: {
          type: 'user',
          id: result.signIn.userId,
          roles: result.signIn.roles,
          residentStatus: result.residentStatus,
        },
      });
    });
  }

  api.post('/auth/refresh', { schema: { body: RefreshBody } }, async (request, reply) => {
    const presented =
      clientFromHeader(request) === 'native'
        ? request.body.refreshToken
        : request.cookies[REFRESH_COOKIE_NAME];
    if (!presented) {
      throw new AppError('AUTH_REQUIRED', 401, 'No refresh token presented.');
    }

    const rotated = await rotateRefreshToken(db, presented, clock);
    const roles =
      rotated.principalType === 'user' ? await loadUserRoles(db, rotated.principalId) : [];
    const accessToken = await signAccessToken(
      { sub: rotated.principalId, typ: rotated.principalType, sid: rotated.sessionId, roles },
      env.JWT_SECRET,
    );
    const expiresAt = new Date(clock.now().getTime() + 15 * 60 * 1000).toISOString();

    sendTokens(
      request,
      reply,
      env,
      {
        accessToken,
        expiresAt,
        refreshToken: rotated.refreshToken,
        sessionId: rotated.sessionId,
      },
      {},
    );
  });

  api.post('/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    const principal = request.principal;
    if (principal && principal.type !== 'device') {
      await withTx(db, { principal, requestId: request.id }, async (trx) => {
        await revokeSession(trx, principal.sessionId, 'logout', clock);
      });
    }
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: '/v1/auth' }).status(204).send();
  });

  api.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');

    if (principal.type === 'user') {
      authorize(principal, 'me.read', { ownerType: 'user', ownerId: principal.userId });
      const row = await db
        .selectFrom('haven.users')
        .select(['id', 'full_name', 'email', 'phone', 'phone_verified_at'])
        .where('id', '=', principal.userId)
        .executeTakeFirstOrThrow();
      const residentStatus = await getResidentStatus(db, principal.userId);
      reply.send({
        type: 'user',
        id: row.id,
        fullName: row.full_name,
        email: row.email,
        phone: row.phone,
        phoneVerified: row.phone_verified_at !== null,
        roles: principal.roles,
        residentStatus,
      });
      return;
    }
    if (principal.type === 'device') {
      throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
    }

    authorize(principal, 'me.read', { ownerType: 'visitor', ownerId: principal.visitorId });
    const row = await db
      .selectFrom('haven.visitors')
      .select(['id', 'full_name', 'phone', 'gender', 'is_adult_confirmed'])
      .where('id', '=', principal.visitorId)
      .executeTakeFirstOrThrow();
    reply.send({
      type: 'visitor',
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      gender: row.gender,
      isAdultConfirmed: row.is_adult_confirmed,
    });
  });

  api.patch(
    '/me',
    { schema: { body: PatchMeBody }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal) throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');

      if (principal.type === 'user') {
        authorize(principal, 'me.update', { ownerType: 'user', ownerId: principal.userId });
        if (request.body.gender) {
          throw new AppError('VALIDATION_FAILED', 400, 'gender can only be set by guests.');
        }
        await withTx(db, { principal, requestId: request.id }, async (trx) => {
          if (request.body.fullName) {
            await trx
              .updateTable('haven.users')
              .set({ full_name: request.body.fullName })
              .where('id', '=', principal.userId)
              .execute();
          }
        });
        reply.status(204).send();
        return;
      }
      if (principal.type === 'device') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in required.');
      }

      authorize(principal, 'me.update', { ownerType: 'visitor', ownerId: principal.visitorId });
      await withTx(db, { principal, requestId: request.id }, async (trx) => {
        const patch: Record<string, unknown> = {};
        if (request.body.fullName) patch.full_name = request.body.fullName;
        if (request.body.gender) patch.gender = request.body.gender;
        if (request.body.isAdultConfirmed) patch.is_adult_confirmed = true;
        if (Object.keys(patch).length > 0) {
          await trx
            .updateTable('haven.visitors')
            .set(patch)
            .where('id', '=', principal.visitorId)
            .execute();
        }
      });
      reply.status(204).send();
    },
  );

  // POST /v1/me/profile-photo — guest profile selfie (SDD §9.4, G-05).
  api.post('/me/profile-photo', { preHandler: requireAuth }, async (request, reply) => {
    const principal = request.principal;
    if (!principal || principal.type !== 'visitor') {
      throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a guest to upload a profile photo.');
    }
    const file = await request.file();
    if (!file) throw new AppError('PHOTO_REQUIRED', 400, 'A photo is required.');
    const raw = await file.toBuffer();
    const result = await storeVisitorProfilePhoto({
      db,
      storage: opts.mediaStorage,
      clock,
      raw,
      visitorId: principal.visitorId,
    });
    reply.send(result);
  });

  api.post(
    '/invites/:token/claim',
    { schema: { params: InviteClaimParams }, preHandler: requireAuth },
    async (request, reply) => {
      const principal = request.principal;
      if (!principal || principal.type !== 'visitor') {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a guest to claim this invite.');
      }
      const { token } = request.params;
      const visitorRow = await db
        .selectFrom('haven.visitors')
        .select('phone')
        .where('id', '=', principal.visitorId)
        .executeTakeFirstOrThrow();
      const visitorPhone = visitorRow.phone;
      if (!visitorPhone) {
        throw new AppError('AUTH_REQUIRED', 401, 'Sign in as a guest to claim this invite.');
      }

      const result = await withTx(db, { principal, requestId: request.id }, async (trx) =>
        claimInvite(trx, { token, visitorId: principal.visitorId, visitorPhone }, clock),
      );
      reply.status(200).send(result);
    },
  );
}
