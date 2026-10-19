import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { buildTestApp, db, issueToken } from './app-test-helpers.js';
import { TEST_DATABASE_URL } from './pg-test-constants.js';
import { hostelWorld, type HostelWorld } from './staff-fixtures.js';

/**
 * FINAL-QA-REPORT D-04. SDD §9.9: "API holds one dedicated pg connection with LISTEN
 * haven_events"; §11.7: the pooler (6543) is for queries, the direct connection (5432)
 * for LISTEN. The two URLs point at the same test database here, so each is tagged
 * with its own application_name to see which one the hub actually opened.
 */

const NOW = new Date('2026-10-12T06:30:00.000Z');
const tagged = (name: string) =>
  `${TEST_DATABASE_URL}${TEST_DATABASE_URL.includes('?') ? '&' : '?'}application_name=${name}`;

let app: FastifyInstance;
let clock: FakeClock;
let w: HostelWorld;

beforeAll(async () => {
  await resetAllHavenTables();
  clock = new FakeClock(NOW);
  app = await buildTestApp(clock, {
    env: {
      DATABASE_URL: tagged('haven_pooled_probe'),
      DATABASE_DIRECT_URL: tagged('haven_direct_probe'),
    },
    streamPingMs: 200,
  });
  w = await hostelWorld();
});
afterAll(async () => {
  await app.close();
});

describe('the SSE hub LISTENs on DATABASE_DIRECT_URL (§9.9, §11.7)', () => {
  it('opening a stream starts LISTEN on the direct connection, not the pooled one', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const auth = `Bearer ${await issueToken(clock, { type: 'user', id: w.wardenId })}`;
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port,
            path: `/v1/stream?hostelId=${w.hostelId}`,
            headers: { Authorization: auth },
          },
          resolve,
        )
        .on('error', reject);
    });
    expect(res.statusCode).toBe(200);

    const listeners = await sql<{ application_name: string }>`
      select application_name from pg_stat_activity
       where datname = current_database() and query ilike 'LISTEN haven_events%'`.execute(db);
    res.destroy();
    expect(listeners.rows.map((r) => r.application_name)).toEqual(['haven_direct_probe']);
  });
});
