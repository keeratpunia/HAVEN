import { Writable } from 'node:stream';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { buildTestApp } from './app-test-helpers.js';

/**
 * §9.13: every response carries X-Server-Time (the injected clock), and adding it must
 * not disturb the response pipeline. The first version (an async onSend hook) still
 * answered 200 but made Fastify write the headers twice on every request — "Reply was
 * already sent" / ERR_HTTP_HEADERS_SENT in the log, thousands of times in a 1-hour
 * rehearsal. Found in the live rehearsal, 2026-10-19.
 */
describe('X-Server-Time header', () => {
  it('is set on success and error responses without any "already sent" error', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const clock = new FakeClock(new Date('2026-10-12T07:30:00.000Z'));
    const app = await buildTestApp(clock, { env: { LOG_LEVEL: 'info' }, logStream });
    try {
      for (const [path, status] of [
        ['/v1/hostels', 200],
        ['/health', 200],
        ['/v1/me', 401],
        ['/v1/does-not-exist', 404],
      ] as const) {
        const res = await supertest(app.server).get(path);
        expect(res.status).toBe(status);
        expect(res.headers['x-server-time']).toBe('2026-10-12T07:30:00.000Z');
      }
      await new Promise((r) => setTimeout(r, 200));
      const problems = lines.filter((l) => /already sent|HEADERS_SENT|unhandled error/.test(l));
      expect(problems).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
