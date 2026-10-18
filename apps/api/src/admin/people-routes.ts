import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  AdminResidentsQuerySchema,
  CreateBanBodySchema,
  LiftBanBodySchema,
  RejectResidentBodySchema,
  SuspendResidentBodySchema,
  type AdminResidentDTO,
  type BanDTO,
} from '@haven/shared';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, pageOf } from '../lib/paging.js';
import { withTx } from '../lib/tx.js';
import { authorize } from '../auth/policy.js';
import { isSuperAdmin } from '../auth/principal.js';
import type { RevocationCache } from '../auth/principal-loader.js';
import type { MediaUrlSigner } from '../media/signing.js';
import { deleteMedia, type MediaStorage } from '../gate/media.js';
import { enqueueNotification } from '../notify/outbox.js';
import { hostSuspendedText, residentDecidedText } from '../notify/templates.js';
import { assertInHostel, staffScope, staffUser } from './scope.js';
import { writeAudit } from './audit.js';
import { cancelFutureVisits, endAllSessions } from './effects.js';

/** W-04 Residents tab, W-07 Bans, W-08 Residents (SDD §12.9; F7 step 6-7; FR-05, FR-07, FR-54). */

const USER = z.object({ userId: z.string().uuid() });
const ID = z.object({ id: z.string().uuid() });
const BansQuery = z.object({ active: z.enum(['true', 'false']).default('true') });

export interface PeopleRoutesOptions {
  db: Kysely<Database>;
  clock: Clock;
  signer: MediaUrlSigner;
  storage: MediaStorage;
  cache: RevocationCache | null;
}

export async function registerAdminPeopleRoutes(
  app: FastifyInstance,
  opts: PeopleRoutesOptions,
): Promise<void> {
  const { db, clock, signer } = opts;
  const api = app.withTypeProvider<ZodTypeProvider>();

  async function scopedResident(request: FastifyRequest, userId: string) {
    const row = await db
      .selectFrom('haven.residents')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) throw new AppError('NOT_FOUND', 404, 'Resident not found.');
    assertInHostel(row.hostel_id, request.hostelId);
    return row;
  }

  async function residentDto(userIds: string[]): Promise<AdminResidentDTO[]> {
    if (userIds.length === 0) return [];
    const rows = await db
      .selectFrom('haven.residents')
      .innerJoin('haven.users', 'haven.users.id', 'haven.residents.user_id')
      .leftJoin('haven.rooms', 'haven.rooms.id', 'haven.residents.room_id')
      .select([
        'haven.residents.user_id',
        'haven.residents.hostel_id',
        'haven.residents.claimed_room',
        'haven.residents.status',
        'haven.residents.submitted_at',
        'haven.residents.decided_at',
        'haven.residents.rejection_reason',
        'haven.residents.hosting_suspended_until',
        'haven.residents.id_card_media_id',
        'haven.residents.selfie_media_id',
        'haven.users.full_name',
        'haven.users.email',
        'haven.users.phone',
        'haven.rooms.number',
      ])
      .where('haven.residents.user_id', 'in', userIds)
      .execute();
    const out: AdminResidentDTO[] = [];
    for (const id of userIds) {
      const r = rows.find((x) => x.user_id === id);
      if (!r) continue;
      const room = r.number ?? r.claimed_room;
      const roommates = await db
        .selectFrom('haven.residents')
        .innerJoin('haven.users', 'haven.users.id', 'haven.residents.user_id')
        .innerJoin('haven.rooms', 'haven.rooms.id', 'haven.residents.room_id')
        .select(['haven.residents.user_id', 'haven.users.full_name'])
        .where('haven.residents.hostel_id', '=', r.hostel_id)
        .where('haven.rooms.number', '=', room)
        .where('haven.residents.status', '=', 'verified')
        .where('haven.residents.user_id', '!=', r.user_id)
        .execute();
      const pending = r.status === 'pending' && r.submitted_at !== null;
      out.push({
        userId: r.user_id,
        fullName: r.full_name,
        email: r.email,
        phone: r.phone,
        room,
        status: r.status,
        submittedAt: r.submitted_at?.toISOString() ?? null,
        decidedAt: r.decided_at?.toISOString() ?? null,
        rejectionReason: r.rejection_reason,
        hostingSuspendedUntil: r.hosting_suspended_until?.toISOString() ?? null,
        // FR-05: ID card visible only while the decision is pending; it's deleted after.
        idCardPhoto: pending ? signer.signOrNull(r.id_card_media_id) : null,
        selfie: signer.signOrNull(r.selfie_media_id),
        roommates: roommates.map((m) => ({ userId: m.user_id, fullName: m.full_name })),
      });
    }
    return out;
  }

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

  // GET /v1/admin/residents?status&q — W-04 Residents tab, W-08.
  api.get(
    '/admin/residents',
    { schema: { querystring: AdminResidentsQuerySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.residents.read', { hostelId: request.hostelId });
      const offset = decodeCursor(request.query.cursor);
      let q = db
        .selectFrom('haven.residents')
        .innerJoin('haven.users', 'haven.users.id', 'haven.residents.user_id')
        .leftJoin('haven.rooms', 'haven.rooms.id', 'haven.residents.room_id')
        .select(['haven.residents.user_id'])
        .where('haven.residents.hostel_id', '=', request.hostelId);
      if (request.query.status === 'pending') {
        // "Pending residents" = submitted and awaiting a decision (W-01 tile, W-04).
        q = q
          .where('haven.residents.status', '=', 'pending')
          .where('haven.residents.submitted_at', 'is not', null);
      } else if (request.query.status) {
        q = q.where('haven.residents.status', '=', request.query.status);
      }
      if (request.query.q) {
        const like = `%${request.query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where((eb) =>
          eb.or([
            eb('haven.users.full_name', 'ilike', like),
            eb('haven.users.email', 'ilike', like),
            eb('haven.residents.claimed_room', 'ilike', like),
            eb('haven.rooms.number', 'ilike', like),
          ]),
        );
      }
      const rows = await q
        .orderBy('haven.residents.submitted_at', 'asc')
        .orderBy('haven.residents.user_id')
        .offset(offset)
        .limit(request.query.limit + 1)
        .execute();
      const page = pageOf(rows, offset, request.query.limit);
      const items = await residentDto(page.items.map((r) => r.user_id));
      // T15 "all reads of photos ... are audited": ID-card and selfie URLs handed out
      // here are reads of identity documents (SECURITY-AUDIT SA-11).
      const withDocs = items.filter((r) => r.idCardPhoto || r.selfie).map((r) => r.userId);
      if (withDocs.length > 0) {
        await audit(db, request, 'read.resident_documents', 'residents', null, {
          residentIds: withDocs,
        });
      }
      reply.send({ items, nextCursor: page.nextCursor });
    },
  );

  /** Shared by verify and reject (F7 step 7): only a submitted, undecided resident. */
  async function decide(
    request: FastifyRequest,
    userId: string,
    decision: 'verified' | 'rejected',
    reason?: string,
  ) {
    authorize(request.principal, 'admin.residents.verify', { hostelId: request.hostelId });
    const resident = await scopedResident(request, userId);
    if (resident.status !== 'pending' || !resident.submitted_at) {
      throw new AppError(
        'INVALID_TRANSITION',
        409,
        'This resident is not waiting for verification.',
      );
    }
    const user = staffUser(request);
    const now = clock.now();
    await withTx(db, { principal: request.principal, requestId: request.id }, async (trx) => {
      let roomId: string | null = null;
      if (decision === 'verified') {
        // "Creates room if needed" (SDD §12.9).
        const room = await trx
          .insertInto('haven.rooms')
          .values({ hostel_id: resident.hostel_id, number: resident.claimed_room })
          .onConflict((oc) =>
            oc.columns(['hostel_id', 'number']).doUpdateSet({ number: resident.claimed_room }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        roomId = room.id;
      }
      const updated = await trx
        .updateTable('haven.residents')
        .set({
          status: decision,
          room_id: decision === 'verified' ? roomId : resident.room_id,
          decided_by: user.userId,
          decided_at: now.toISOString(),
          rejection_reason: decision === 'rejected' ? (reason ?? null) : null,
          id_card_media_id: null,
        })
        .where('user_id', '=', userId)
        .where('status', '=', 'pending')
        .returning('user_id')
        .executeTakeFirst();
      if (!updated)
        throw new AppError('INVALID_TRANSITION', 409, 'This was updated by someone else.');
      await enqueueNotification(trx, {
        now,
        hostelId: resident.hostel_id,
        recipient: { type: 'user', userId },
        kind: 'N-RES-DECIDED',
        channel: 'push',
        text: residentDecidedText(
          decision === 'verified' ? { decision } : { decision, reason: reason ?? '' },
        ),
        dedupeKey: `res-decided:${userId}:${now.toISOString()}`,
      });
      await audit(
        trx,
        request,
        `admin.residents.${decision === 'verified' ? 'verify' : 'reject'}`,
        'residents',
        userId,
        reason ? { reason } : undefined,
      );
    });
    // "ID card image is deleted on decision" (FR-05; SDD §16.5: synchronously).
    if (resident.id_card_media_id) {
      await deleteMedia({ db, storage: opts.storage, clock, mediaId: resident.id_card_media_id });
      await audit(db, request, 'admin.media.delete_id_card', 'media', resident.id_card_media_id);
    }
    const [dto] = await residentDto([userId]);
    return dto;
  }

  // POST /v1/admin/residents/:userId/verify (FR-05, F7 step 7).
  api.post(
    '/admin/residents/:userId/verify',
    { schema: { params: USER }, preHandler: staffScope },
    async (request, reply) => {
      reply.send(await decide(request, request.params.userId, 'verified'));
    },
  );

  // POST /v1/admin/residents/:userId/reject { reason } (FR-05).
  api.post(
    '/admin/residents/:userId/reject',
    { schema: { params: USER, body: RejectResidentBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      reply.send(await decide(request, request.params.userId, 'rejected', request.body.reason));
    },
  );

  // POST /v1/admin/residents/:userId/suspend { until?, reason } — cancels future visits (BR-10).
  api.post(
    '/admin/residents/:userId/suspend',
    { schema: { params: USER, body: SuspendResidentBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.residents.suspend', { hostelId: request.hostelId });
      const resident = await scopedResident(request, request.params.userId);
      if (resident.status !== 'verified' && resident.status !== 'suspended') {
        throw new AppError('INVALID_TRANSITION', 409, 'Only a verified resident can be suspended.');
      }
      const until = request.body.until ? new Date(request.body.until) : null;
      if (until && until <= clock.now()) {
        throw new AppError('VALIDATION_FAILED', 400, 'The end date must be in the future.');
      }
      const user = staffUser(request);
      await withTx(db, { principal: request.principal, requestId: request.id }, async (trx) => {
        await trx
          .updateTable('haven.residents')
          .set({ status: 'suspended', hosting_suspended_until: until ? until.toISOString() : null })
          .where('user_id', '=', resident.user_id)
          .execute();
        const cancelled = await cancelFutureVisits(trx, {
          where: { hostId: resident.user_id },
          reason: 'host_suspended',
          clock,
          actorUserId: user.userId,
        });
        await enqueueNotification(trx, {
          now: clock.now(),
          hostelId: resident.hostel_id,
          recipient: { type: 'user', userId: resident.user_id },
          kind: 'N-HOST-SUSPENDED',
          channel: 'push',
          text: hostSuspendedText({ until }),
          dedupeKey: `host-suspended:${resident.user_id}:${clock.now().toISOString()}`,
        });
        await audit(trx, request, 'admin.residents.suspend', 'residents', resident.user_id, {
          reason: request.body.reason,
          until: until?.toISOString() ?? null,
          cancelledVisits: cancelled.length,
        });
      });
      const [dto] = await residentDto([resident.user_id]);
      reply.send(dto);
    },
  );

  // POST /v1/admin/residents/:userId/unsuspend.
  api.post(
    '/admin/residents/:userId/unsuspend',
    { schema: { params: USER }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.residents.suspend', { hostelId: request.hostelId });
      const resident = await scopedResident(request, request.params.userId);
      if (resident.status !== 'suspended') {
        throw new AppError('INVALID_TRANSITION', 409, 'This resident is not suspended.');
      }
      await withTx(db, { principal: request.principal, requestId: request.id }, async (trx) => {
        await trx
          .updateTable('haven.residents')
          .set({ status: 'verified', hosting_suspended_until: null })
          .where('user_id', '=', resident.user_id)
          .execute();
        await audit(trx, request, 'admin.residents.unsuspend', 'residents', resident.user_id);
      });
      const [dto] = await residentDto([resident.user_id]);
      reply.send(dto);
    },
  );

  // POST /v1/admin/residents/:userId/mark-left — FR-07, E-18: sessions end, future visits cancelled.
  api.post(
    '/admin/residents/:userId/mark-left',
    { schema: { params: USER }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.residents.mark_left', { hostelId: request.hostelId });
      const resident = await scopedResident(request, request.params.userId);
      if (resident.status === 'left')
        throw new AppError('INVALID_TRANSITION', 409, 'Already marked as left.');
      const user = staffUser(request);
      await withTx(db, { principal: request.principal, requestId: request.id }, async (trx) => {
        await trx
          .updateTable('haven.residents')
          .set({ status: 'left' })
          .where('user_id', '=', resident.user_id)
          .execute();
        const cancelled = await cancelFutureVisits(trx, {
          where: { hostId: resident.user_id },
          reason: 'host_left',
          clock,
          actorUserId: user.userId,
        });
        const sessions = await endAllSessions(trx, {
          userId: resident.user_id,
          reason: 'resident_left',
          clock,
          cache: opts.cache,
        });
        await audit(trx, request, 'admin.residents.mark_left', 'residents', resident.user_id, {
          cancelledVisits: cancelled.length,
          sessionsEnded: sessions,
        });
      });
      const [dto] = await residentDto([resident.user_id]);
      reply.send(dto);
    },
  );

  // GET /v1/admin/bans — W-07.
  api.get(
    '/admin/bans',
    { schema: { querystring: BansQuery }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.bans.read', { hostelId: request.hostelId });
      let q = db
        .selectFrom('haven.bans')
        .innerJoin('haven.visitors', 'haven.visitors.id', 'haven.bans.visitor_id')
        .selectAll('haven.bans')
        .select('haven.visitors.full_name')
        .where((eb) =>
          eb.or([
            eb('haven.bans.hostel_id', '=', request.hostelId),
            eb('haven.bans.hostel_id', 'is', null),
          ]),
        );
      if (request.query.active === 'true') {
        q = q
          .where('haven.bans.lifted_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('haven.bans.ends_at', 'is', null),
              eb('haven.bans.ends_at', '>', clock.now()),
            ]),
          );
      }
      const rows = await q.orderBy('haven.bans.created_at', 'desc').limit(200).execute();
      const items: BanDTO[] = rows.map((b) => ({
        id: b.id,
        visitorId: b.visitor_id,
        guestName: b.full_name,
        allHostels: b.hostel_id === null,
        reason: b.reason,
        startsAt: b.starts_at.toISOString(),
        endsAt: b.ends_at?.toISOString() ?? null,
        createdAt: b.created_at.toISOString(),
        liftedAt: b.lifted_at?.toISOString() ?? null,
      }));
      reply.send({ items });
    },
  );

  // POST /v1/admin/bans — FR-54; BR-09; cancels the guest's future visits (§7.1, E-12).
  api.post(
    '/admin/bans',
    { schema: { body: CreateBanBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.bans.write', { hostelId: request.hostelId });
      const body = request.body;
      // The guest must be known to this hostel (a visit here) — a warden can't ban by
      // guessing ids for guests they have never seen.
      const known = await db
        .selectFrom('haven.visits')
        .select('id')
        .where('visitor_id', '=', body.visitorId)
        .where('hostel_id', '=', request.hostelId)
        .executeTakeFirst();
      if (!known) throw new AppError('NOT_FOUND', 404, 'Guest not found.');
      const endsAt = body.endsAt ? new Date(body.endsAt) : null;
      if (endsAt && endsAt <= clock.now())
        throw new AppError('VALIDATION_FAILED', 400, 'The end date must be in the future.');
      const user = staffUser(request);
      const ban = await withTx(
        db,
        { principal: request.principal, requestId: request.id },
        async (trx) => {
          const row = await trx
            .insertInto('haven.bans')
            .values({
              visitor_id: body.visitorId,
              hostel_id: body.allHostels ? null : request.hostelId,
              reason: body.reason,
              starts_at: clock.now(),
              ends_at: endsAt ? endsAt.toISOString() : null,
              created_by: user.userId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const cancelled = await cancelFutureVisits(trx, {
            where: {
              visitorId: body.visitorId,
              hostelId: body.allHostels ? null : request.hostelId,
            },
            reason: 'guest_banned',
            clock,
            actorUserId: user.userId,
          });
          await audit(trx, request, 'admin.bans.create', 'bans', row.id, {
            reason: body.reason,
            allHostels: body.allHostels,
            cancelledVisits: cancelled.length,
          });
          return row;
        },
      );
      reply.status(201).send({ id: ban.id });
    },
  );

  // POST /v1/admin/bans/:id/lift — bans are lifted, never deleted (CLAUDE.md §3.11).
  api.post(
    '/admin/bans/:id/lift',
    { schema: { params: ID, body: LiftBanBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.bans.write', { hostelId: request.hostelId });
      const ban = await db
        .selectFrom('haven.bans')
        .selectAll()
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!ban) throw new AppError('NOT_FOUND', 404, 'Ban not found.');
      const user = staffUser(request);
      // An all-hostels ban reaches beyond this hostel: only the warden who placed it or
      // a super admin may lift it (DEC-014). A hostel ban must belong to this hostel.
      if (ban.hostel_id === null) {
        if (ban.created_by !== user.userId && !isSuperAdmin(request.principal)) {
          throw new AppError('FORBIDDEN', 403, "You don't have permission to do that.");
        }
      } else {
        assertInHostel(ban.hostel_id, request.hostelId);
      }
      if (ban.lifted_at)
        throw new AppError('INVALID_TRANSITION', 409, 'This ban was already lifted.');
      await withTx(db, { principal: request.principal, requestId: request.id }, async (trx) => {
        await trx
          .updateTable('haven.bans')
          .set({
            lifted_at: clock.now().toISOString(),
            lifted_by: user.userId,
            lift_reason: request.body.reason,
          })
          .where('id', '=', ban.id)
          .execute();
        await audit(trx, request, 'admin.bans.lift', 'bans', ban.id, {
          reason: request.body.reason,
        });
      });
      reply.status(204).send();
    },
  );
}
