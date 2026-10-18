import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  AdminChargesQuerySchema,
  CreateFineBodySchema,
  MarkPaidBodySchema,
  WaiveBodySchema,
  type AdminChargeDTO,
} from '@haven/shared';
import type { ZodTypeProvider } from '../lib/validation.js';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, pageOf } from '../lib/paging.js';
import { withTx } from '../lib/tx.js';
import { authorize } from '../auth/policy.js';
import { hasHostelRole } from '../auth/principal.js';
import type { Principal } from '../auth/principal.js';
import type { MediaUrlSigner } from '../media/signing.js';
import type { RulesProvider } from '../rules/provider.js';
import { enqueueNotification } from '../notify/outbox.js';
import { chargeText } from '../notify/templates.js';
import { assertInHostel, staffScope, staffUser } from './scope.js';
import { writeAudit } from './audit.js';

/** O-01 / warden Charges (SDD §12.9, FR-59, BR-08, BR-18). */

const ID = z.object({ id: z.string().uuid() });

export interface ChargesRoutesOptions {
  db: Kysely<Database>;
  clock: Clock;
  signer: MediaUrlSigner;
  rules: RulesProvider;
}

interface ChargeRow {
  id: string;
  hostel_id: string;
  resident_id: string;
  visit_id: string | null;
  kind: 'overnight_room' | 'guest_room' | 'fine';
  amount_inr: number;
  description: string;
  status: 'pending' | 'confirmed' | 'paid' | 'waived';
  created_at: Date;
  receipt_no: string | null;
  waive_reason: string | null;
  resident_name: string;
  room_number: string | null;
  claimed_room: string;
  visit_code: string | null;
  visitor_name: string | null;
  invited_name: string | null;
  visitor_phone: string | null;
  invited_phone: string | null;
  profile_media_id: string | null;
}

/**
 * The one place charge rows become JSON. Office callers (no warden role in this hostel)
 * get no guest phone and no photo — the keys are not sent at all (SDD §3.4: "Office
 * endpoints MUST strip visitor.phone and all photo URLs ... enforced in the serializer";
 * TC-SEC-03).
 */
export function serializeCharge(
  row: ChargeRow,
  viewer: 'warden' | 'office',
  signer: MediaUrlSigner,
): AdminChargeDTO {
  const visit = row.visit_id
    ? {
        id: row.visit_id,
        code: row.visit_code ?? '',
        guestName: row.visitor_name ?? row.invited_name ?? 'Guest',
        ...(viewer === 'warden'
          ? {
              guestPhone: row.visitor_phone ?? row.invited_phone ?? null,
              guestPhoto: signer.signOrNull(row.profile_media_id),
            }
          : {}),
      }
    : null;
  return {
    id: row.id,
    resident: {
      id: row.resident_id,
      name: row.resident_name,
      room: row.room_number ?? row.claimed_room,
    },
    kind: row.kind,
    amountInr: row.amount_inr,
    description: row.description,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    receiptNo: row.receipt_no,
    waiveReason: row.waive_reason,
    visit,
  };
}

function viewerRole(principal: Principal | null, hostelId: string): 'warden' | 'office' {
  return hasHostelRole(principal, hostelId, ['warden']) ? 'warden' : 'office';
}

export async function registerAdminChargesRoutes(
  app: FastifyInstance,
  opts: ChargesRoutesOptions,
): Promise<void> {
  const { db, clock, signer } = opts;
  const api = app.withTypeProvider<ZodTypeProvider>();

  function baseQuery() {
    return db
      .selectFrom('haven.charges')
      .innerJoin('haven.users as resident', 'resident.id', 'haven.charges.resident_id')
      .innerJoin('haven.residents', 'haven.residents.user_id', 'haven.charges.resident_id')
      .leftJoin('haven.rooms', 'haven.rooms.id', 'haven.residents.room_id')
      .leftJoin('haven.visits', 'haven.visits.id', 'haven.charges.visit_id')
      .leftJoin('haven.visitors', 'haven.visitors.id', 'haven.visits.visitor_id')
      .select([
        'haven.charges.id',
        'haven.charges.hostel_id',
        'haven.charges.resident_id',
        'haven.charges.visit_id',
        'haven.charges.kind',
        'haven.charges.amount_inr',
        'haven.charges.description',
        'haven.charges.status',
        'haven.charges.created_at',
        'haven.charges.receipt_no',
        'haven.charges.waive_reason',
        'resident.full_name as resident_name',
        'haven.rooms.number as room_number',
        'haven.residents.claimed_room',
        'haven.visits.code as visit_code',
        'haven.visitors.full_name as visitor_name',
        'haven.visits.invited_name',
        'haven.visitors.phone as visitor_phone',
        'haven.visits.invited_phone',
        'haven.visitors.profile_media_id',
      ]);
  }

  async function one(request: FastifyRequest, id: string): Promise<AdminChargeDTO> {
    const row = (await baseQuery().where('haven.charges.id', '=', id).executeTakeFirst()) as
      ChargeRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', 404, 'Charge not found.');
    assertInHostel(row.hostel_id, request.hostelId);
    return serializeCharge(row, viewerRole(request.principal, request.hostelId), signer);
  }

  function audit(
    trx: Parameters<typeof writeAudit>[0],
    request: FastifyRequest,
    action: string,
    id: string,
    detail?: Record<string, unknown>,
  ) {
    return writeAudit(trx, {
      actorId: staffUser(request).userId,
      hostelId: request.hostelId,
      action,
      entity: 'charges',
      entityId: id,
      detail,
      ip: request.ip,
      requestId: request.id,
    });
  }

  /** Moves a charge from one of `from` to `to` with an optimistic status guard. */
  async function transition(
    request: FastifyRequest,
    id: string,
    from: ('pending' | 'confirmed')[],
    set: Record<string, unknown>,
    action: string,
    detail?: Record<string, unknown>,
    notify?: boolean,
  ) {
    await one(request, id); // scope + existence
    await withTx(db, { principal: request.principal, requestId: request.id }, async (trx) => {
      const row = await trx
        .updateTable('haven.charges')
        .set(set)
        .where('id', '=', id)
        .where('status', 'in', from)
        .returning(['resident_id', 'hostel_id', 'amount_inr', 'description', 'status'])
        .executeTakeFirst();
      if (!row) throw new AppError('INVALID_TRANSITION', 409, 'This charge was already updated.');
      await audit(trx, request, action, id, detail);
      if (notify) {
        // N-CHARGE: "Charge created or marked paid" → resident, in-app.
        await enqueueNotification(trx, {
          now: clock.now(),
          hostelId: row.hostel_id,
          recipient: { type: 'user', userId: row.resident_id },
          kind: 'N-CHARGE',
          channel: 'in_app',
          text: chargeText({
            amountInr: row.amount_inr,
            description: row.description,
            status: 'paid',
          }),
          dedupeKey: `charge:${id}:${row.status}`,
        });
      }
    });
    return one(request, id);
  }

  // GET /v1/admin/charges?status&q&cursor — warden, office (office: no photos/phones).
  api.get(
    '/admin/charges',
    { schema: { querystring: AdminChargesQuerySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.charges.read', { hostelId: request.hostelId });
      const q = request.query;
      const offset = decodeCursor(q.cursor);
      let query = baseQuery().where('haven.charges.hostel_id', '=', request.hostelId);
      if (q.status) query = query.where('haven.charges.status', '=', q.status);
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        query = query.where((eb) =>
          eb.or([
            eb('resident.full_name', 'ilike', like),
            eb('haven.rooms.number', 'ilike', like),
            eb('haven.residents.claimed_room', 'ilike', like),
            eb('haven.charges.receipt_no', 'ilike', like),
          ]),
        );
      }
      const rows = (await query
        .orderBy('haven.charges.created_at', 'desc')
        .orderBy('haven.charges.id')
        .offset(offset)
        .limit(q.limit + 1)
        .execute()) as ChargeRow[];
      const page = pageOf(rows, offset, q.limit);
      const viewer = viewerRole(request.principal, request.hostelId);
      reply.send({
        items: page.items.map((r) => serializeCharge(r, viewer, signer)),
        nextCursor: page.nextCursor,
      });
    },
  );

  // POST /v1/admin/charges — manual fine, min ₹400 (BR-18; amount ≥ min_manual_fine_inr).
  api.post(
    '/admin/charges',
    { schema: { body: CreateFineBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.charges.create_fine', { hostelId: request.hostelId });
      const { config } = await opts.rules.forHostel(request.hostelId);
      const body = request.body;
      if (body.amountInr < config.min_manual_fine_inr) {
        throw new AppError(
          'VALIDATION_FAILED',
          400,
          `A fine is at least ₹${config.min_manual_fine_inr}.`,
          {
            issues: [{ path: ['amountInr'], message: `Minimum ${config.min_manual_fine_inr}` }],
          },
        );
      }
      const resident = await db
        .selectFrom('haven.residents')
        .select(['user_id', 'hostel_id'])
        .where('user_id', '=', body.residentId)
        .executeTakeFirst();
      if (!resident) throw new AppError('NOT_FOUND', 404, 'Resident not found.');
      assertInHostel(resident.hostel_id, request.hostelId);
      if (body.visitId) {
        const visit = await db
          .selectFrom('haven.visits')
          .select(['hostel_id', 'host_id'])
          .where('id', '=', body.visitId)
          .executeTakeFirst();
        if (!visit || visit.hostel_id !== request.hostelId || visit.host_id !== body.residentId) {
          throw new AppError('NOT_FOUND', 404, 'Visit not found.');
        }
      }
      const user = staffUser(request);
      const id = await withTx(
        db,
        { principal: request.principal, requestId: request.id },
        async (trx) => {
          const row = await trx
            .insertInto('haven.charges')
            .values({
              hostel_id: request.hostelId,
              resident_id: body.residentId,
              visit_id: body.visitId ?? null,
              kind: 'fine',
              units: null,
              unit_price_inr: null,
              amount_inr: body.amountInr,
              description: body.description,
              status: 'pending',
              created_by: user.userId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await audit(trx, request, 'admin.charges.create_fine', row.id, {
            amountInr: body.amountInr,
          });
          await enqueueNotification(trx, {
            now: clock.now(),
            hostelId: request.hostelId,
            recipient: { type: 'user', userId: body.residentId },
            kind: 'N-CHARGE',
            channel: 'in_app',
            text: chargeText({
              amountInr: body.amountInr,
              description: body.description,
              status: 'pending',
            }),
            dedupeKey: `charge:${row.id}:created`,
          });
          return row.id;
        },
      );
      reply.status(201).send(await one(request, id));
    },
  );

  // POST /v1/admin/charges/:id/confirm — warden, office.
  api.post(
    '/admin/charges/:id/confirm',
    { schema: { params: ID }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.charges.confirm', { hostelId: request.hostelId });
      const user = staffUser(request);
      reply.send(
        await transition(
          request,
          request.params.id,
          ['pending'],
          {
            status: 'confirmed',
            confirmed_by: user.userId,
            confirmed_at: clock.now().toISOString(),
          },
          'admin.charges.confirm',
        ),
      );
    },
  );

  // POST /v1/admin/charges/:id/mark-paid { receiptNo } — warden, office.
  api.post(
    '/admin/charges/:id/mark-paid',
    { schema: { params: ID, body: MarkPaidBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.charges.mark_paid', { hostelId: request.hostelId });
      const user = staffUser(request);
      reply.send(
        await transition(
          request,
          request.params.id,
          ['pending', 'confirmed'],
          {
            status: 'paid',
            paid_recorded_by: user.userId,
            paid_at: clock.now().toISOString(),
            receipt_no: request.body.receiptNo,
          },
          'admin.charges.mark_paid',
          { receiptNo: request.body.receiptNo },
          true,
        ),
      );
    },
  );

  // POST /v1/admin/charges/:id/waive { reason } — warden only.
  api.post(
    '/admin/charges/:id/waive',
    { schema: { params: ID, body: WaiveBodySchema }, preHandler: staffScope },
    async (request, reply) => {
      authorize(request.principal, 'admin.charges.waive', { hostelId: request.hostelId });
      const user = staffUser(request);
      reply.send(
        await transition(
          request,
          request.params.id,
          ['pending', 'confirmed'],
          {
            status: 'waived',
            waived_by: user.userId,
            waived_at: clock.now().toISOString(),
            waive_reason: request.body.reason,
          },
          'admin.charges.waive',
          { reason: request.body.reason },
        ),
      );
    },
  );
}
