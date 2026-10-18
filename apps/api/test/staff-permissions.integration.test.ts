import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { GH8_RULES_CONFIG_V1 } from '@haven/shared';
import { FakeClock } from '../src/lib/clock.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { buildTestApp, db, idem, MemoryMediaStorage } from './app-test-helpers.js';
import {
  grant,
  hostelWorld,
  makeUser,
  pendingResident,
  ROLES,
  seedCharge,
  seedVisit,
  tokensFor,
  type HostelWorld,
  type Role,
} from './staff-fixtures.js';

/**
 * SDD §3.3 permission matrix, staff rows: one test per capability per role (guest,
 * resident, warden, office, super admin, gate device). Allowed roles get a 2xx; every
 * other role gets the exact SDD §12.2 code — 403 FORBIDDEN when the action is denied,
 * or 404 NOT_FOUND where the record isn't visible to the caller (the /v1/visits routes).
 */

const NOW = new Date('2026-10-12T06:30:00.000Z'); // 12:00 IST
const HOUR = 3_600_000;

interface Ctx {
  app: FastifyInstance;
  w: HostelWorld;
  superId: string;
  storage: MemoryMediaStorage;
  auth: Record<Role, string>;
}

type Call = (ctx: Ctx, authHeader: string) => Promise<supertest.Response>;
type Denial = { status: number; code: string };

interface Capability {
  name: string;
  allowed: Role[];
  call: Call;
  /** How a role outside `allowed` is refused; FORBIDDEN unless overridden. */
  denial?: Partial<Record<Role, Denial>>;
}

const FORBIDDEN: Denial = { status: 403, code: 'FORBIDDEN' };
const NOT_FOUND: Denial = { status: 404, code: 'NOT_FOUND' };

function admin(
  method: 'get' | 'post' | 'put',
  path: string,
  body?: object,
  extra: Record<string, string> = {},
) {
  return (ctx: Ctx, authHeader: string) => {
    let r = supertest(ctx.app.server)
      [method](path)
      .set('Authorization', authHeader)
      .set('X-Hostel-Id', ctx.w.hostelId);
    for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
    return body ? r.send(body) : r;
  };
}

const insideVisit = (ctx: Ctx) =>
  seedVisit({
    hostelId: ctx.w.hostelId,
    hostId: ctx.w.residentId,
    visitorId: ctx.w.visitorId,
    status: 'inside',
    windowStart: new Date(NOW.getTime() - HOUR),
    windowEnd: new Date(NOW.getTime() + 2 * HOUR),
  });

const CAPABILITIES: Capability[] = [
  {
    name: 'Approve overnight / guest room (POST /visits/:id/approve)',
    allowed: ['warden'],
    // The visit isn't visible to the guest or office: NOT_FOUND. Super admin can see it
    // ("See visits": All) but approving is "--": FORBIDDEN.
    // The resident here is the visit's own host: they can see it, but only a warden
    // approves it. A gate device has no user access token at all.
    denial: {
      guest: NOT_FOUND,
      office: NOT_FOUND,
      resident: FORBIDDEN,
      super_admin: FORBIDDEN,
      gate_device: { status: 401, code: 'AUTH_REQUIRED' },
    },
    call: async (ctx, a) => {
      const id = await seedVisit({
        hostelId: ctx.w.hostelId,
        hostId: ctx.w.residentId,
        status: 'pending_warden',
        type: 'overnight_room',
        nights: 1,
        windowStart: new Date(NOW.getTime() + 24 * HOUR),
        windowEnd: new Date(NOW.getTime() + 48 * HOUR),
      });
      return supertest(ctx.app.server)
        .post(`/v1/visits/${id}/approve`)
        .set('Authorization', a)
        .set('Idempotency-Key', idem())
        .send({});
    },
  },
  {
    name: 'See visits (GET /admin/visits)',
    allowed: ['warden', 'super_admin'],
    call: admin('get', '/v1/admin/visits'),
  },
  {
    name: 'See guest photos and phone (GET /admin/visits/:id)',
    allowed: ['warden', 'super_admin'],
    call: async (ctx, a) => admin('get', `/v1/admin/visits/${await insideVisit(ctx)}`)(ctx, a),
  },
  {
    name: 'Force check-out a guest',
    allowed: ['warden'],
    call: async (ctx, a) =>
      admin(
        'post',
        `/v1/admin/visits/${await insideVisit(ctx)}/force-checkout`,
        { reason: 'left unscanned' },
        { 'Idempotency-Key': idem() },
      )(ctx, a),
  },
  {
    name: 'Resolve a dispute',
    allowed: ['warden'],
    call: async (ctx, a) => {
      const id = await seedVisit({
        hostelId: ctx.w.hostelId,
        hostId: ctx.w.residentId,
        visitorId: ctx.w.visitorId,
        status: 'inside',
        disputed: true,
        windowStart: new Date(NOW.getTime() - HOUR),
        windowEnd: new Date(NOW.getTime() + HOUR),
      });
      return admin('post', `/v1/admin/visits/${id}/resolve-dispute`, { note: 'Host mistake' })(
        ctx,
        a,
      );
    },
  },
  { name: 'Dashboard (W-01)', allowed: ['warden'], call: admin('get', '/v1/admin/dashboard') },
  {
    name: 'Emergency roll call (W-03)',
    allowed: ['warden'],
    call: admin('get', '/v1/admin/emergency'),
  },
  {
    name: 'Overnight approvals queue (W-04)',
    allowed: ['warden'],
    call: admin('get', '/v1/admin/approvals'),
  },
  {
    name: 'Verify residents',
    allowed: ['warden', 'super_admin'],
    call: async (ctx, a) => {
      const r = await pendingResident(ctx.w.hostelId, ctx.storage);
      return admin('post', `/v1/admin/residents/${r.userId}/verify`)(ctx, a);
    },
  },
  {
    name: 'Reject residents',
    allowed: ['warden', 'super_admin'],
    call: async (ctx, a) => {
      const r = await pendingResident(ctx.w.hostelId, ctx.storage);
      return admin('post', `/v1/admin/residents/${r.userId}/reject`, { reason: 'ID unreadable' })(
        ctx,
        a,
      );
    },
  },
  {
    name: 'Edit rules',
    allowed: ['warden', 'super_admin'],
    call: admin('post', '/v1/admin/rules', {
      config: { ...GH8_RULES_CONFIG_V1, max_active_day_guests: 2 },
    }),
  },
  {
    name: 'Ban guests',
    allowed: ['warden', 'super_admin'],
    call: async (ctx, a) => {
      await insideVisit(ctx);
      return admin('post', '/v1/admin/bans', {
        visitorId: ctx.w.visitorId,
        allHostels: false,
        reason: 'Unknown guest',
      })(ctx, a);
    },
  },
  {
    name: 'Suspend hosts',
    allowed: ['warden', 'super_admin'],
    call: (ctx, a) =>
      admin('post', `/v1/admin/residents/${ctx.w.residentId}/suspend`, { reason: 'Rule 26.5' })(
        ctx,
        a,
      ),
  },
  {
    name: 'Mark a resident as left (FR-07)',
    allowed: ['warden'],
    call: (ctx, a) => admin('post', `/v1/admin/residents/${ctx.w.residentId}/mark-left`)(ctx, a),
  },
  { name: 'View charges', allowed: ['warden', 'office'], call: admin('get', '/v1/admin/charges') },
  {
    name: 'Create manual fine',
    allowed: ['warden'],
    call: (ctx, a) =>
      admin('post', '/v1/admin/charges', {
        residentId: ctx.w.residentId,
        amountInr: 400,
        description: 'Unregistered guest',
      })(ctx, a),
  },
  {
    name: 'Confirm a charge',
    allowed: ['warden', 'office'],
    call: async (ctx, a) =>
      admin(
        'post',
        `/v1/admin/charges/${await seedCharge({ hostelId: ctx.w.hostelId, residentId: ctx.w.residentId })}/confirm`,
      )(ctx, a),
  },
  {
    name: 'Mark a charge paid',
    allowed: ['warden', 'office'],
    call: async (ctx, a) =>
      admin(
        'post',
        `/v1/admin/charges/${await seedCharge({ hostelId: ctx.w.hostelId, residentId: ctx.w.residentId })}/mark-paid`,
        { receiptNo: 'R-001' },
      )(ctx, a),
  },
  {
    name: 'Waive a charge',
    allowed: ['warden'],
    call: async (ctx, a) =>
      admin(
        'post',
        `/v1/admin/charges/${await seedCharge({ hostelId: ctx.w.hostelId, residentId: ctx.w.residentId })}/waive`,
        { reason: 'Goodwill' },
      )(ctx, a),
  },
  { name: 'See gates', allowed: ['warden', 'super_admin'], call: admin('get', '/v1/admin/gates') },
  {
    name: 'Pair gate devices',
    allowed: ['warden', 'super_admin'],
    call: (ctx, a) => admin('post', `/v1/admin/gates/${ctx.w.gate.gateId}/pairing-codes`)(ctx, a),
  },
  {
    name: 'Set gate location',
    allowed: ['warden', 'super_admin'],
    call: (ctx, a) =>
      admin('put', `/v1/admin/gates/${ctx.w.gate.gateId}/location`, {
        lat: 12.97,
        lng: 77.59,
        radiusM: 50,
        maxAccuracyM: 75,
      })(ctx, a),
  },
  {
    name: 'Revoke gate devices',
    allowed: ['warden', 'super_admin'],
    call: async (ctx, a) => {
      const device = await db
        .selectFrom('haven.gate_devices')
        .select('id')
        .where('gate_id', '=', ctx.w.gate.gateId)
        .where('revoked_at', 'is', null)
        .executeTakeFirstOrThrow();
      return admin('post', `/v1/admin/gate-devices/${device.id}/revoke`)(ctx, a);
    },
  },
  { name: 'Staff list', allowed: ['warden'], call: admin('get', '/v1/admin/staff') },
  {
    name: 'Invite office staff',
    allowed: ['warden'],
    call: admin('post', '/v1/admin/staff-invites', {
      email: 'new.office@gmail.test',
      role: 'office',
    }),
  },
  {
    name: 'Deactivate office staff (FR-07)',
    allowed: ['warden'],
    call: async (ctx, a) => {
      const other = await makeUser('Second Office');
      await grant(other, 'office', ctx.w.hostelId);
      return admin('post', `/v1/admin/staff/${other}/deactivate`)(ctx, a);
    },
  },
  {
    name: 'Invite wardens',
    allowed: ['super_admin'],
    call: admin('post', '/v1/admin/staff-invites', {
      email: 'new.warden@gmail.test',
      role: 'warden',
    }),
  },
  {
    name: 'Create hostels',
    allowed: ['super_admin'],
    call: admin('post', '/v1/admin/hostels', {
      code: 'GH-9',
      name: 'Second Hostel',
      genderServed: 'male',
    }),
  },
  {
    name: 'View audit log',
    allowed: ['warden', 'super_admin'],
    call: admin('get', '/v1/admin/audit'),
  },
  {
    name: 'Reports CSV (W-12)',
    allowed: ['warden'],
    call: admin('get', '/v1/admin/reports/visits.csv?from=2026-10-01&to=2026-10-31'),
  },
];

let ctx: Ctx;
let clock: FakeClock;

beforeEach(async () => {
  await resetAllHavenTables();
  clock = new FakeClock(NOW);
  const storage = new MemoryMediaStorage();
  const app = await buildTestApp(clock, { mediaStorage: storage, streamPingMs: 200 });
  const w = await hostelWorld();
  const superId = await makeUser('Sam Super');
  await grant(superId, 'super_admin', null);
  const auth = await tokensFor(app, clock, w, superId);
  ctx = { app, w, superId, storage, auth };
});

afterEach(async () => {
  await ctx.app.close();
});

describe('SDD §3.3 permission matrix — staff capabilities', () => {
  for (const cap of CAPABILITIES) {
    describe(cap.name, () => {
      for (const role of ROLES) {
        const allowed = cap.allowed.includes(role);
        it(`${role}: ${allowed ? 'allowed' : 'refused'}`, async () => {
          const res = await cap.call(ctx, ctx.auth[role]);
          if (allowed) {
            expect([200, 201, 204], JSON.stringify(res.body)).toContain(res.status);
          } else {
            const denial = cap.denial?.[role] ?? FORBIDDEN;
            expect(res.status, JSON.stringify(res.body)).toBe(denial.status);
            expect(res.body.error.code).toBe(denial.code);
          }
        });
      }
    });
  }
});

describe('Live updates (GET /v1/stream) — warden and office only', () => {
  for (const role of ROLES) {
    const allowed = role === 'warden' || role === 'office';
    it(`${role}: ${allowed ? 'allowed' : 'refused with FORBIDDEN'}`, async () => {
      const res = await openStream(ctx.app, ctx.w.hostelId, ctx.auth[role]);
      res.destroy();
      if (allowed) {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
      } else {
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body ?? '{}').error.code).toBe('FORBIDDEN');
      }
    });
  }
});

describe('Unauthenticated and malformed staff requests', () => {
  it('no credentials → 401 AUTH_REQUIRED', async () => {
    const res = await supertest(ctx.app.server)
      .get('/v1/admin/dashboard')
      .set('X-Hostel-Id', ctx.w.hostelId);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('missing X-Hostel-Id → 400 VALIDATION_FAILED', async () => {
    const res = await supertest(ctx.app.server)
      .get('/v1/admin/dashboard')
      .set('Authorization', ctx.auth.warden);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

export type StreamResponse = http.IncomingMessage & { body?: string };

/** Opens the SSE endpoint over a real socket and resolves on the first response bytes. */
export async function openStream(
  app: FastifyInstance,
  hostelId: string,
  authHeader: string,
): Promise<StreamResponse> {
  if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: `/v1/stream?hostelId=${hostelId}`,
        headers: { Authorization: authHeader },
      },
      (res: StreamResponse) => {
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            res.body = body;
            resolve(res);
          });
        } else {
          resolve(res);
        }
      },
    );
    req.on('error', reject);
  });
}
