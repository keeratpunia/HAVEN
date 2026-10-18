import { describe, expect, it } from 'vitest';
import { scrubSentryEvent, scrubText } from './scrub.js';

/** docs/SECURITY-AUDIT.md SA-13: nothing personal reaches the error tracker. */
describe('scrubSentryEvent', () => {
  const event = {
    message: 'Failed for +919876543210 with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHgifQ.c2lnbmF0dXJlLXZhbHVl',
    user: { id: 'u1', email: 'priya@example.com', ip_address: '1.2.3.4' },
    server_name: 'api-1',
    request: {
      method: 'GET',
      url: 'https://api.haven.test/v1/invites/SECRET-TOKEN?q=9876543210',
      headers: { authorization: 'Bearer x', cookie: 'haven_rt=y' },
      cookies: { haven_rt: 'y' },
      data: { phone: '+919876543210', code: '123456' },
      query_string: 'sig=abc',
    },
    breadcrumbs: [{ message: 'GET /v1/media/1?sig=abc', data: { url: '/v1/media/1?sig=abc' } }],
    extra: {
      refreshToken: 'rt',
      gate: { secret: 'shh' },
      err: { code: 'AUTH_REQUIRED' },
      otp: { code: '654321' },
      note: 'emailed asha@example.com about 98765 43210',
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: 'GET /v1/media/abc?exp=1&sig=SIG failed',
          stacktrace: { frames: [{ abs_path: 'D:/HAVEN/apps/api/src/app.ts', lineno: 10 }] },
        },
      ],
    },
  };

  it('drops users, request data and breadcrumb data, and scrubs every string', () => {
    const out = scrubSentryEvent(event);
    const text = JSON.stringify(out);
    for (const secret of [
      '9876543210',
      'eyJhbGciOiJIUzI1NiJ9',
      'priya@example.com',
      'asha@example.com',
      'SECRET-TOKEN',
      'haven_rt',
      '123456',
      '654321',
      'shh',
      '"rt"',
      'SIG',
      '1.2.3.4',
      'api-1',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(out.user).toBeUndefined();
    expect(out.request).toEqual({ method: 'GET', url: 'https://api.haven.test/v1/invites/[redacted]' });
  });

  it('keeps what makes an error diagnosable: error codes and stack frames', () => {
    const out = scrubSentryEvent(event) as typeof event;
    expect(out.extra.err.code).toBe('AUTH_REQUIRED');
    expect(out.exception.values[0]?.stacktrace.frames[0]).toEqual({
      abs_path: 'D:/HAVEN/apps/api/src/app.ts',
      lineno: 10,
    });
  });

  it('masks phones to their last five digits', () => {
    expect(scrubText('call +91 9876543210 or 919876512345')).toBe('call +91•••••43210 or +91•••••12345');
  });
});
