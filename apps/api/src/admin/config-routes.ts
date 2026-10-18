import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  AuditQuerySchema,
  CreateHostelBodySchema,
  GateLocationBodySchema,
  GH8_RULES_CONFIG_V1,
  localDateTimeToUtc,
  PublishRulesBodySchema,
  StaffInviteBodySchema,
  type AuditRowDTO,
  type GateDTO,
  type RulesDTO,
  type StaffDTO,
} from '@haven/shared';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, pageOf } from '../lib/paging.js';
import { withTx } from '../lib/tx.js';
import { encryptAesGcm, randomSecret, sha256 } from '../lib/crypto.js';
import { generateGateCode } from '../lib/ids.js';
import { authorize } from '../auth/policy.js';
import type { RevocationCache } from '../auth/principal-loader.js';
import { createPairingCode, revokeDevice } from '../gate/devices.js';
import type { RulesProvider } from '../rules/provider.js';
import { assertInHostel, staffScope, staffUser } from './scope.js';
import { writeAudit } from './audit.js';
import { endAllSessions } from './effects.js';

/** W-06 Rules, W-09 Gates, W-10 Staff (+ super admin hostels), W-11 Audit (SDD §12.9). */

const ID = z.object({ id: z.string().uuid() });
const USER = z.object({ userId: z.string().uuid() });
const STAFF_INVITE_TTL_MS = 48 * 3_600_000; // FR-06: "Invites expire in 48 h"
const ONLINE_WINDOW_MS = 5 * 60_000;

export interface ConfigRoutesOptions {
  db: Kysely<Database>;
  clock: Clock;
  rules: RulesProvider;
  dataEncryptionKey: Buffer;
  webBaseUrl: string;
  cache: RevocationCache | null;
}

export async function registerAdminConfigRoutes(
  app: FastifyInstance,
  opts: ConfigRoutesOptions,
): Promise<void> {
  const { db, clock, rules } = opts;
  const api = app.withTypeProvider<ZodTypeProvider>();

  function audit(
    trx: Parameters<typeof writeAudit>[0],
    request: FastifyRequest,
    action: string,
    entity: string,
    entityId: string | null,
    detail?: Record<string, unknown>,
  ) {
    return writeAudit(trx, {
      actorId: staffUser(request).userId,
      hostelId: request.hostelId,
      action,
      entity,
      entityId,
      detail,
      ip: request.ip,
      requestId: request.id,
    });
  }

  // ---- Rules (W-06, FR-55) ----

  api.get('/admin/rules', { preHandler: staffScope }, async (request, reply) => {
    authorize(request.principal, 'admin.rules.read', { hostelId: request.hostelId });
    const row = await db
      .selectFrom('haven.hostel_rules')
      .select(['version', 'created_at'])
      .where('hostel_id', '=', request.hostelId)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();
    const current = await rules.forHostel(request.hostelId);
    const dto: RulesDTO = {
      version: current.version,
      config: current.config,
      createdAt: row?.created_at.toISOString() ?? null,
    };
    reply.send(dto);
  });

  // POST /v1/admin/rules — "publish new version (validated)"; §4.3: the API refuses an invalid config.
  api.post(
    '/admin/rules',
    { schema: { body: PublishRulesBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.rules.write', { hostelId: request.hostelId });
      const hostel = await db
        .selectFrom('haven.hostels')
        .select(['gender_served', 'timezone'])
        .where('id', '=', request.hostelId)
        .executeTakeFirst();
      if (!hostel) throw new AppError('NOT_FOUND', 404, 'Hostel not found.');
      const config = request.body.config;
      // The hostel's gender and timezone are facts about the hostel, not rules to edit.
      if (config.hostel_gender !== hostel.gender_served || config.timezone !== hostel.timezone) {
        throw new AppError(
          'VALIDATION_FAILED',
          400,
          "The hostel's gender and timezone can't be changed here.",
          {
            issues: [{ path: ['config', 'hostel_gender'], message: 'Must match the hostel' }],
          },
        );
      }
      const user = staffUser(request);
      const version = await withTx(
        db,
        { principal: request.principal, requestId: request.id },
        async (trx) => {
          const latest = await trx
            .selectFrom('haven.hostel_rules')
            .select((eb) => eb.fn.max('version').as('v'))
            .where('hostel_id', '=', request.hostelId)
            .executeTakeFirst();
          const next = Number(latest?.v ?? 0) + 1;
          await trx
            .insertInto('haven.hostel_rules')
            .values({
              hostel_id: request.hostelId,
              version: next,
              config: JSON.stringify(config),
              created_by: user.userId,
            })
            .execute();
          await audit(trx, request, 'admin.rules.publish', 'hostel_rules', null, { version: next });
          return next;
        },
      );
      rules.invalidate(request.hostelId);
      reply
        .status(201)
        .send({ version, config, createdAt: clock.now().toISOString() } satisfies RulesDTO);
    },
  );

  // ---- Gates (W-09, FR-56, FR-29, E-14) ----

  async function gateDtos(hostelId: string): Promise<GateDTO[]> {
    const gates = await db
      .selectFrom('haven.gates')
      .selectAll()
      .where('hostel_id', '=', hostelId)
      .where('is_active', '=', true)
      .orderBy('code')
      .execute();
    if (gates.length === 0) return [];
    const devices = await db
      .selectFrom('haven.gate_devices')
      .select(['id', 'gate_id', 'label', 'last_seen_at', 'paired_at'])
      .where(
        'gate_id',
        'in',
        gates.map((g) => g.id),
      )
      .where('revoked_at', 'is', null)
      .orderBy('paired_at')
      .execute();
    const now = clock.now().getTime();
    return gates.map((g) => ({
      id: g.id,
      code: g.code,
      name: g.name,
      lat: g.lat,
      lng: g.lng,
      radiusM: g.radius_m,
      maxAccuracyM: g.max_accuracy_m,
      configured: g.lat !== null && g.lng !== null,
      locationSetAt: g.location_set_at?.toISOString() ?? null,
      devices: devices
        .filter((d) => d.gate_id === g.id)
        .map((d) => ({
          id: d.id,
          label: d.label,
          online: d.last_seen_at !== null && now - d.last_seen_at.getTime() <= ONLINE_WINDOW_MS,
          lastSeenAt: d.last_seen_at?.toISOString() ?? null,
          pairedAt: d.paired_at.toISOString(),
        })),
    }));
  }

  async function scopedGate(request: FastifyRequest, gateId: string) {
    const gate = await db
      .selectFrom('haven.gates')
      .select(['id', 'hostel_id'])
      .where('id', '=', gateId)
      .executeTakeFirst();
    if (!gate) throw new AppError('NOT_FOUND', 404, 'Gate not found.');
    assertInHostel(gate.hostel_id, request.hostelId);
    return gate;
  }

  api.get('/admin/gates', { preHandler: staffScope }, async (request, reply) => {
    authorize(request.principal, 'admin.gates.read', { hostelId: request.hostelId });
    reply.send({ items: await gateDtos(request.hostelId) });
  });

  // PUT /v1/admin/gates/:id/location — F8 step 4 (the app averages the 5 readings).
  api.put(
    '/admin/gates/:id/location',
    { schema: { params: ID, body: GateLocationBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.gates.write', { hostelId: request.hostelId });
      const gate = await scopedGate(request, request.params.id);
      const user = staffUser(request);
      await withTx(db, { principal: request.principal, requestId: request.id }, async (trx) => {
        await trx
          .updateTable('haven.gates')
          .set({
            lat: request.body.lat,
            lng: request.body.lng,
            radius_m: request.body.radiusM,
            max_accuracy_m: request.body.maxAccuracyM,
            location_set_by: user.userId,
            location_set_at: clock.now().toISOString(),
          })
          .where('id', '=', gate.id)
          .execute();
        await audit(trx, request, 'admin.gates.set_location', 'gates', gate.id, {
          radiusM: request.body.radiusM,
        });
      });
      const dto = (await gateDtos(request.hostelId)).find((g) => g.id === gate.id);
      reply.send(dto);
    },
  );

  // POST /v1/admin/gates/:id/pairing-codes — F8 step 1.
  api.post(
    '/admin/gates/:id/pairing-codes',
    { schema: { params: ID }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.gates.write', { hostelId: request.hostelId });
      const gate = await scopedGate(request, request.params.id);
      const user = staffUser(request);
      const result = await createPairingCode({
        db,
        clock,
        gateId: gate.id,
        createdByUserId: user.userId,
      });
      await audit(db, request, 'admin.gates.create_pairing_code', 'gates', gate.id);
      reply.send({ code: result.displayCode, expiresAt: result.expiresAt.toISOString() });
    },
  );

  // POST /v1/admin/gate-devices/:id/revoke — "Rotates gate secret" (F8 step 5).
  api.post(
    '/admin/gate-devices/:id/revoke',
    { schema: { params: ID }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.gates.write', { hostelId: request.hostelId });
      const device = await db
        .selectFrom('haven.gate_devices')
        .innerJoin('haven.gates', 'haven.gates.id', 'haven.gate_devices.gate_id')
        .select(['haven.gate_devices.id', 'haven.gates.hostel_id', 'haven.gate_devices.revoked_at'])
        .where('haven.gate_devices.id', '=', request.params.id)
        .executeTakeFirst();
      if (!device) throw new AppError('NOT_FOUND', 404, 'Device not found.');
      assertInHostel(device.hostel_id, request.hostelId);
      if (device.revoked_at)
        throw new AppError('INVALID_TRANSITION', 409, 'This device was already removed.');
      const user = staffUser(request);
      await revokeDevice({
        db,
        clock,
        dataEncryptionKey: opts.dataEncryptionKey,
        deviceId: device.id,
        revokedByUserId: user.userId,
      });
      await audit(db, request, 'admin.gates.revoke_device', 'gate_devices', device.id);
      reply.status(204).send();
    },
  );

  // ---- Staff (W-10, FR-06, FR-07, F11) ----

  api.get('/admin/staff', { preHandler: staffScope }, async (request, reply) => {
    authorize(request.principal, 'admin.staff.read', { hostelId: request.hostelId });
    const members = await db
      .selectFrom('haven.role_assignments')
      .innerJoin('haven.users', 'haven.users.id', 'haven.role_assignments.user_id')
      .select([
        'haven.users.id',
        'haven.users.full_name',
        'haven.users.email',
        'haven.users.is_active',
        'haven.role_assignments.role',
        'haven.role_assignments.granted_at',
      ])
      .where('haven.role_assignments.hostel_id', '=', request.hostelId)
      .where('haven.role_assignments.revoked_at', 'is', null)
      .orderBy('haven.role_assignments.role')
      .orderBy('haven.users.full_name')
      .execute();
    const invites = await db
      .selectFrom('haven.staff_invites')
      .select(['id', 'email', 'role', 'expires_at', 'accepted_at'])
      .where('hostel_id', '=', request.hostelId)
      .where('revoked_at', 'is', null)
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    const dto: StaffDTO = {
      members: members
        .filter((m): m is typeof m & { role: 'warden' | 'office' } => m.role !== 'super_admin')
        .map((m) => ({
          userId: m.id,
          fullName: m.full_name,
          email: m.email,
          role: m.role,
          grantedAt: m.granted_at.toISOString(),
          active: m.is_active,
        })),
      invites: invites
        .filter((i): i is typeof i & { role: 'warden' | 'office' } => i.role !== 'super_admin')
        .map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          expiresAt: i.expires_at.toISOString(),
          acceptedAt: i.accepted_at?.toISOString() ?? null,
        })),
    };
    reply.send(dto);
  });

  // POST /v1/admin/staff-invites { email, role } — warden: office; super admin: warden (F11).
  api.post(
    '/admin/staff-invites',
    { schema: { body: StaffInviteBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      const role = request.body.role;
      authorize(
        request.principal,
        role === 'warden' ? 'admin.staff.invite_warden' : 'admin.staff.invite_office',
        {
          hostelId: request.hostelId,
        },
      );
      const hostel = await db
        .selectFrom('haven.hostels')
        .select('id')
        .where('id', '=', request.hostelId)
        .executeTakeFirst();
      if (!hostel) throw new AppError('NOT_FOUND', 404, 'Hostel not found.');
      const token = randomSecret(24).toString('base64url');
      const expiresAt = new Date(clock.now().getTime() + STAFF_INVITE_TTL_MS);
      const user = staffUser(request);
      const id = await withTx(
        db,
        { principal: request.principal, requestId: request.id },
        async (trx) => {
          const row = await trx
            .insertInto('haven.staff_invites')
            .values({
              hostel_id: request.hostelId,
              role,
              email: request.body.email,
              token_hash: sha256(token),
              invited_by: user.userId,
              expires_at: expiresAt.toISOString(),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await audit(trx, request, `admin.staff.invite_${role}`, 'staff_invites', row.id);
          return row.id;
        },
      );
      // "returns a link; warden shares it" (F11 step 2).
      reply.status(201).send({
        id,
        inviteUrl: `${opts.webBaseUrl.replace(/\/$/, '')}/staff-invite/${token}`,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  // POST /v1/admin/staff/:userId/deactivate — FR-07 (office staff of this hostel, DEC-014).
  api.post(
    '/admin/staff/:userId/deactivate',
    { schema: { params: USER }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.staff.deactivate', { hostelId: request.hostelId });
      const user = staffUser(request);
      if (request.params.userId === user.userId) {
        throw new AppError('FORBIDDEN', 403, "You can't deactivate yourself.");
      }
      const grant = await db
        .selectFrom('haven.role_assignments')
        .select('id')
        .where('user_id', '=', request.params.userId)
        .where('hostel_id', '=', request.hostelId)
        .where('role', '=', 'office')
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!grant) throw new AppError('NOT_FOUND', 404, 'Staff member not found.');
      await withTx(db, { principal: request.principal, requestId: request.id }, async (trx) => {
        await trx
          .updateTable('haven.role_assignments')
          .set({ revoked_at: clock.now().toISOString(), revoked_by: user.userId })
          .where('id', '=', grant.id)
          .execute();
        const remaining = await trx
          .selectFrom('haven.role_assignments')
          .select('id')
          .where('user_id', '=', request.params.userId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        // No role left anywhere and not a resident: the account itself is deactivated.
        const resident = await trx
          .selectFrom('haven.residents')
          .select('status')
          .where('user_id', '=', request.params.userId)
          .executeTakeFirst();
        if (!remaining && (!resident || resident.status === 'left')) {
          await trx
            .updateTable('haven.users')
            .set({ is_active: false })
            .where('id', '=', request.params.userId)
            .execute();
        }
        const sessions = await endAllSessions(trx, {
          userId: request.params.userId,
          reason: 'staff_deactivated',
          clock,
          cache: opts.cache,
        });
        await audit(trx, request, 'admin.staff.deactivate', 'users', request.params.userId, {
          sessionsEnded: sessions,
        });
      });
      reply.status(204).send();
    },
  );

  // POST /v1/admin/hostels — super admin "create hostels" (§3.3; DEC-014: no §12.9 row).
  api.post(
    '/admin/hostels',
    { schema: { body: CreateHostelBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.hostels.create', { hostelId: request.hostelId });
      const body = request.body;
      const exists = await db
        .selectFrom('haven.hostels')
        .select('id')
        .where('code', '=', body.code)
        .executeTakeFirst();
      if (exists) throw new AppError('CONFLICT', 409, 'A hostel with that code already exists.');
      const user = staffUser(request);
      const created = await withTx(
        db,
        { principal: request.principal, requestId: request.id },
        async (trx) => {
          const hostel = await trx
            .insertInto('haven.hostels')
            .values({ code: body.code, name: body.name, gender_served: body.genderServed })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('haven.hostel_rules')
            .values({
              hostel_id: hostel.id,
              version: 1,
              config: JSON.stringify({ ...GH8_RULES_CONFIG_V1, hostel_gender: body.genderServed }),
              created_by: user.userId,
            })
            .execute();
          // One gate with no location: GATE_NOT_CONFIGURED until the warden sets it (E-14).
          const gate = await trx
            .insertInto('haven.gates')
            .values({
              hostel_id: hostel.id,
              code: generateGateCode(),
              secret_enc: encryptAesGcm(randomSecret(32), opts.dataEncryptionKey),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await writeAudit(trx, {
            actorId: user.userId,
            hostelId: hostel.id,
            action: 'admin.hostels.create',
            entity: 'hostels',
            entityId: hostel.id,
            detail: { code: body.code, gateId: gate.id },
            ip: request.ip,
            requestId: request.id,
          });
          return hostel.id;
        },
      );
      reply.status(201).send({ id: created, code: body.code, name: body.name });
    },
  );

  // ---- Audit (W-11, FR-58) ----

  api.get(
    '/admin/audit',
    { schema: { querystring: AuditQuerySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.audit.read', { hostelId: request.hostelId });
      const q = request.query;
      const { config } = await rules.forHostel(request.hostelId);
      const offset = decodeCursor(q.cursor);
      let query = db
        .selectFrom('haven.audit_log')
        .leftJoin('haven.users', 'haven.users.id', 'haven.audit_log.actor_id')
        .select([
          'haven.audit_log.id',
          'haven.audit_log.at',
          'haven.audit_log.actor_type',
          'haven.audit_log.actor_id',
          'haven.users.full_name',
          'haven.audit_log.action',
          'haven.audit_log.entity',
          'haven.audit_log.entity_id',
          'haven.audit_log.after',
        ])
        .where('haven.audit_log.hostel_id', '=', request.hostelId);
      if (q.entity) query = query.where('haven.audit_log.entity', '=', q.entity);
      if (q.entityId) query = query.where('haven.audit_log.entity_id', '=', q.entityId);
      if (q.actorId) query = query.where('haven.audit_log.actor_id', '=', q.actorId);
      if (q.from)
        query = query.where(
          'haven.audit_log.at',
          '>=',
          localDateTimeToUtc(q.from, '00:00', config.timezone),
        );
      if (q.to) {
        query = query.where(
          'haven.audit_log.at',
          '<',
          new Date(localDateTimeToUtc(q.to, '00:00', config.timezone).getTime() + 86_400_000),
        );
      }
      const rows = await query
        .orderBy('haven.audit_log.at', 'desc')
        .orderBy('haven.audit_log.id', 'desc')
        .offset(offset)
        .limit(q.limit + 1)
        .execute();
      const page = pageOf(rows, offset, q.limit);
      const items: AuditRowDTO[] = page.items.map((r) => ({
        id: Number(r.id),
        at: r.at.toISOString(),
        actorType: r.actor_type,
        actorId: r.actor_id,
        actorName: r.full_name,
        action: r.action,
        entity: r.entity,
        entityId: r.entity_id,
        after: r.after,
      }));
      reply.send({ items, nextCursor: page.nextCursor });
    },
  );
}
