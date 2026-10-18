import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import type { Logger } from '../lib/logger.js';
import type { PushSender } from './senders.js';

/** SDD §9.7: "A job fetches receipts 15 min later." */
export const RECEIPT_DELAY_MS = 15 * 60_000;

/**
 * Fetches Expo receipts for pushes sent at least 15 minutes ago and disables any token
 * Expo now reports as `DeviceNotRegistered` (§9.7: "DeviceNotRegistered disables that
 * push_tokens row"). The worker recorded each ticket with its token as
 * "<ticket id>:<push_tokens id>" in provider_ref. Every push is checked once; a receipt
 * Expo doesn't have yet (it keeps them for about a day) is treated as delivered.
 */
export async function checkPushReceipts(p: {
  db: Kysely<Database>;
  push: PushSender;
  now: Date;
  logger?: Pick<Logger, 'warn' | 'error'>;
  batchSize?: number;
}): Promise<{ checked: number; tokensDisabled: number }> {
  const rows = await p.db
    .selectFrom('haven.notifications')
    .select(['id', 'provider_ref'])
    .where('channel', '=', 'push')
    .where('status', '=', 'sent')
    .where('receipt_checked_at', 'is', null)
    .where('sent_at', '<=', new Date(p.now.getTime() - RECEIPT_DELAY_MS))
    .orderBy('sent_at')
    .limit(p.batchSize ?? 300)
    .execute();
  if (rows.length === 0) return { checked: 0, tokensDisabled: 0 };

  const tokenByTicket = new Map<string, string>();
  for (const row of rows) {
    for (const pair of (row.provider_ref ?? '').split(',')) {
      const [ticketId, tokenId] = pair.split(':');
      if (ticketId && tokenId) tokenByTicket.set(ticketId, tokenId);
    }
  }

  const receipts =
    tokenByTicket.size > 0 ? await p.push.getReceipts([...tokenByTicket.keys()]) : {};
  const dead: string[] = [];
  for (const [ticketId, receipt] of Object.entries(receipts)) {
    if (receipt.status !== 'error') continue;
    const tokenId = tokenByTicket.get(ticketId);
    if (receipt.deviceNotRegistered && tokenId) dead.push(tokenId);
    else p.logger?.warn({ ticketId, error: receipt.message }, 'push receipt error');
  }

  if (dead.length > 0) {
    await p.db
      .updateTable('haven.push_tokens')
      .set({ disabled_at: p.now })
      .where('id', 'in', dead)
      .where('disabled_at', 'is', null)
      .execute();
  }
  await p.db
    .updateTable('haven.notifications')
    .set({ receipt_checked_at: p.now.toISOString() })
    .where(
      'id',
      'in',
      rows.map((r) => r.id),
    )
    .execute();
  return { checked: rows.length, tokensDisabled: dead.length };
}
