import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { signAccessToken, verifyAccessToken, type AccessTokenClaims } from './jwt.js';
import { AppError } from '../lib/errors.js';

const SECRET = Buffer.alloc(32, 9).toString('base64');
const OTHER_SECRET = Buffer.alloc(32, 1).toString('base64');

const USER_CLAIMS: AccessTokenClaims = {
  sub: '11111111-1111-1111-1111-111111111111',
  typ: 'user',
  sid: 'session-1',
  roles: [{ h: 'hostel-1', r: 'warden' }],
};

describe('signAccessToken / verifyAccessToken round trip', () => {
  it('verifies a token it just signed, returning the same claims', async () => {
    const token = await signAccessToken(USER_CLAIMS, SECRET);
    const verified = await verifyAccessToken(token, SECRET);
    expect(verified.sub).toBe(USER_CLAIMS.sub);
    expect(verified.typ).toBe('user');
    expect(verified.sid).toBe('session-1');
    expect(verified.roles).toEqual([{ h: 'hostel-1', r: 'warden' }]);
  });

  it('sets a ~15 minute expiry (SDD §9.5)', async () => {
    const token = await signAccessToken(USER_CLAIMS, SECRET);
    const verified = await verifyAccessToken(token, SECRET);
    const ttl = verified.exp - verified.iat;
    expect(ttl).toBe(15 * 60);
  });

  it('round-trips a visitor principal', async () => {
    const token = await signAccessToken(
      { sub: 'visitor-1', typ: 'visitor', sid: 'session-2', roles: [] },
      SECRET,
    );
    const verified = await verifyAccessToken(token, SECRET);
    expect(verified.typ).toBe('visitor');
  });
});

describe('verifyAccessToken failure modes', () => {
  it('rejects a token signed with a different secret, as AUTH_REQUIRED (401)', async () => {
    const token = await signAccessToken(USER_CLAIMS, OTHER_SECRET);
    await expect(verifyAccessToken(token, SECRET)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      httpStatus: 401,
    });
  });

  it('rejects a malformed token string, as AUTH_REQUIRED (401)', async () => {
    await expect(verifyAccessToken('not-a-jwt', SECRET)).rejects.toBeInstanceOf(AppError);
    await expect(verifyAccessToken('not-a-jwt', SECRET)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('rejects a token with the wrong issuer, even with the correct secret', async () => {
    const key = new Uint8Array(Buffer.from(SECRET, 'base64'));
    const token = await new SignJWT({ typ: 'user', sid: 's1', roles: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuer('someone-else')
      .setAudience('haven')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key);
    await expect(verifyAccessToken(token, SECRET)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('rejects a token with the wrong audience, even with the correct secret', async () => {
    const key = new Uint8Array(Buffer.from(SECRET, 'base64'));
    const token = await new SignJWT({ typ: 'user', sid: 's1', roles: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuer('haven-api')
      .setAudience('someone-else')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key);
    await expect(verifyAccessToken(token, SECRET)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('rejects an expired token', async () => {
    const key = new Uint8Array(Buffer.from(SECRET, 'base64'));
    const token = await new SignJWT({ typ: 'user', sid: 's1', roles: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuer('haven-api')
      .setAudience('haven')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    await expect(verifyAccessToken(token, SECRET)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('rejects an empty token string', async () => {
    await expect(verifyAccessToken('', SECRET)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});
