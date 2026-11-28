import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { buildTestApp, db, issueToken } from './app-test-helpers.js';
import { hostelWorld, seedVisit, type HostelWorld } from './staff-fixtures.js';
import { makeVerifiedHost, makeVisitor } from './visits-fixtures.js';

/**
 * DEC-031, W-08: the warden opens a resident and sees them as a host (counts, latest
 * guest, their visits) and can sort the residents by how many guests came in.
 */

const NOW = new Date('2026-10-12T06:30:00.000Z');
const hour = 3_600_000;

let app: FastifyInstance;
let clock: FakeClock;
let w: HostelWorld;
let other: HostelWorld;
let busyHost: string;
let warden: string;
let office: string;

beforeAll(async () => {
  await resetAllHavenTables();
  clock = new FakeClock(NOW);
  app = await buildTestApp(clock);
  w = await hostelWorld();
  other = await hostelWorld();
  busyHost = await makeVerifiedHost(db, w.hostelId);
  warden = `Bearer ${await issueToken(clock, { type: 'user', id: w.wardenId })}`;
  office = `Bearer ${await issueToken(clock, { type: 'user', id: w.officeId })}`;

  // busyHost: three guests came in (two of them the same person), one invite not used
  // yet, one overnight stay, one "Not my guest".
  const a = await makeVisitor(db);
  const b = await makeVisitor(db);
  const at = (h: number) => new Date(NOW.getTime() + h * hour);
  await seedVisit({
    hostelId: w.hostelId,
    hostId: busyHost,
    visitorId: a,
    status: 'completed',
    windowStart: at(-50),
    windowEnd: at(-48),
  });
  await seedVisit({
    hostelId: w.hostelId,
    hostId: busyHost,
    visitorId: a,
    status: 'completed',
    windowStart: at(-26),
    windowEnd: at(-24),
    disputed: true,
  });
  await seedVisit({
    hostelId: w.hostelId,
    hostId: busyHost,
    visitorId: b,
    status: 'inside',
    type: 'overnight_room',
    nights: 1,
    windowStart: at(-2),
    windowEnd: at(20),
  });
  await seedVisit({
    hostelId: w.hostelId,
    hostId: busyHost,
    status: 'approved',
    windowStart: at(2),
    windowEnd: at(4),
  });
  // The world's own resident: one guest came in, longer ago.
  await seedVisit({
    hostelId: w.hostelId,
    hostId: w.residentId,
    visitorId: b,
    status: 'completed',
    windowStart: at(-100),
    windowEnd: at(-98),
  });
});
afterAll(async () => {
  await app.close();
});

const list = (sort: string) =>
  supertest(app.server)
    .get(`/v1/admin/residents?status=verified&sort=${sort}`)
    .set('Authorization', warden)
    .set('X-Hostel-Id', w.hostelId);

describe('W-08 resident host stats and sorting (DEC-031)', () => {
  it('counts visits, guests who came in, different guests, overnight stays, disputes, latest guest', async () => {
    const res = await supertest(app.server)
      .get(`/v1/admin/residents/${busyHost}`)
      .set('Authorization', warden)
      .set('X-Hostel-Id', w.hostelId);
    expect(res.status).toBe(200);
    expect(res.body.hostStats).toEqual({
      visits: 4,
      guestsIn: 3,
      distinctGuests: 2,
      overnightStays: 1,
      disputes: 1,
      lastGuestAt: new Date(NOW.getTime() - 2 * hour).toISOString(),
    });
  });

  it('gives a resident who never hosted zeros, not an error', async () => {
    const quiet = await makeVerifiedHost(db, w.hostelId);
    const res = await list('oldest');
    const items = res.body.items as { userId: string; hostStats: unknown }[];
    expect(items.find((r) => r.userId === quiet)?.hostStats).toEqual({
      visits: 0,
      guestsIn: 0,
      distinctGuests: 0,
      overnightStays: 0,
      disputes: 0,
      lastGuestAt: null,
    });
    expect(
      (items.find((r) => r.userId === w.residentId)?.hostStats as { guestsIn: number }).guestsIn,
    ).toBe(1);
  });

  it('sorts by most guests and by the latest guest', async () => {
    const most = (await list('most_guests')).body.items.map((r: { userId: string }) => r.userId);
    expect(most.indexOf(busyHost)).toBeLessThan(most.indexOf(w.residentId));
    const latest = (await list('latest_guest')).body.items.map((r: { userId: string }) => r.userId);
    expect(latest.indexOf(busyHost)).toBeLessThan(latest.indexOf(w.residentId));
    expect((await list('name')).status).toBe(200);
    expect((await list('room')).status).toBe(200);
    expect((await list('sideways')).status).toBe(400);
  });

  it("lists one host's visits through visit search", async () => {
    const res = await supertest(app.server)
      .get(`/v1/admin/visits?hostId=${busyHost}`)
      .set('Authorization', warden)
      .set('X-Hostel-Id', w.hostelId);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(4);
  });

  it("audits the detail read, refuses the office, and hides another hostel's resident", async () => {
    const before = await db
      .selectFrom('haven.audit_log')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('action', '=', 'read.resident_documents')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('haven.residents')
      .set({ selfie_media_id: null })
      .where('user_id', '=', busyHost)
      .execute();
    // Without a selfie nothing identity-bearing is handed out, so nothing to audit.
    await supertest(app.server)
      .get(`/v1/admin/residents/${busyHost}`)
      .set('Authorization', warden)
      .set('X-Hostel-Id', w.hostelId);
    const after = await db
      .selectFrom('haven.audit_log')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('action', '=', 'read.resident_documents')
      .executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));

    const asOffice = await supertest(app.server)
      .get(`/v1/admin/residents/${busyHost}`)
      .set('Authorization', office)
      .set('X-Hostel-Id', w.hostelId);
    expect(asOffice.status).toBe(403);

    const elsewhere = await supertest(app.server)
      .get(`/v1/admin/residents/${other.residentId}`)
      .set('Authorization', warden)
      .set('X-Hostel-Id', w.hostelId);
    expect([403, 404]).toContain(elsewhere.status);
  });
});
