import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { buildTestApp, db, issueToken } from './app-test-helpers.js';
import { hostelWorld, seedVisit, type HostelWorld } from './staff-fixtures.js';
import { makeVisitor } from './visits-fixtures.js';

/**
 * DEC-032, from the phone test: the ban search must find guests, not the host ("riya"
 * found every guest of "Priya"), and the audit log searches people by name and several
 * record types at once instead of an internal actor id.
 */

const NOW = new Date('2026-10-12T06:30:00.000Z');
let app: FastifyInstance;
let clock: FakeClock;
let w: HostelWorld;
let warden: string;

beforeAll(async () => {
  await resetAllHavenTables();
  clock = new FakeClock(NOW);
  app = await buildTestApp(clock);
  w = await hostelWorld();
  warden = `Bearer ${await issueToken(clock, { type: 'user', id: w.wardenId })}`;
  await db
    .updateTable('haven.users')
    .set({ full_name: 'Priya Sharma' })
    .where('id', '=', w.residentId)
    .execute();
  const guest = await makeVisitor(db);
  await db
    .updateTable('haven.visitors')
    .set({ full_name: 'Kavya Menon' })
    .where('id', '=', guest)
    .execute();
  await seedVisit({
    hostelId: w.hostelId,
    hostId: w.residentId,
    visitorId: guest,
    status: 'completed',
    windowStart: new Date(NOW.getTime() - 5 * 3_600_000),
    windowEnd: new Date(NOW.getTime() - 3 * 3_600_000),
  });
});
afterAll(async () => {
  await app.close();
});

const get = (url: string) =>
  supertest(app.server).get(url).set('Authorization', warden).set('X-Hostel-Id', w.hostelId);

describe('W-07 ban search matches the guest only', () => {
  it('finds a guest by name, but not by their host', async () => {
    expect((await get('/v1/admin/visits?q=riya')).body.items).toHaveLength(1);
    expect((await get('/v1/admin/visits?q=riya&match=guest')).body.items).toHaveLength(0);
    expect((await get('/v1/admin/visits?q=kavya&match=guest')).body.items).toHaveLength(1);
  });
});

describe('W-11 audit log: who and what', () => {
  it('filters by part of a name and by several record types', async () => {
    await supertest(app.server)
      .post(`/v1/admin/residents/${w.residentId}/suspend`)
      .set('Authorization', warden)
      .set('X-Hostel-Id', w.hostelId)
      .send({ reason: 'Test' });
    const byName = await get('/v1/admin/audit?actor=meera');
    expect(byName.status).toBe(200);
    expect(byName.body.items.length).toBeGreaterThan(0);
    expect(
      (byName.body.items as { actorName: string | null }[]).every((r) =>
        /meera/i.test(r.actorName ?? ''),
      ),
    ).toBe(true);
    expect((await get('/v1/admin/audit?actor=nobody-called-this')).body.items).toHaveLength(0);
    const several = await get('/v1/admin/audit?entity=residents,visits');
    expect(several.status).toBe(200);
    expect(
      (several.body.items as { entity: string }[]).every((r) =>
        ['residents', 'visits'].includes(r.entity),
      ),
    ).toBe(true);
    expect((await get('/v1/admin/audit?entity=Residents;drop')).status).toBe(400);
  });
});
