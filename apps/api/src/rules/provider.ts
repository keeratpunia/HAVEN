import type { Kysely } from 'kysely';
import { GH8_RULES_CONFIG_V1, RulesConfigSchema, type RulesConfig } from '@haven/shared';
import type { Database } from '../db/index.js';

/**
 * Per-hostel rules (SDD §4: "All hostel rules are data, stored as a versioned JSON config
 * per hostel"; §9.8: "Rule values are read with haven.rules_for(hostel_id), which returns
 * the latest config"). The rules engine itself stays pure — this is only how the API finds
 * the config to pass it.
 *
 * Cached per hostel because every gate and visit request needs it; `invalidate` is
 * called when the warden publishes a new version (W-06), so new entries use the new
 * rules at once (E-13). One API instance runs in the prototype (SDD §20); a second
 * instance would see a new version within `ttlMs`.
 *
 * A hostel with no `hostel_rules` row yet (tests, a freshly created hostel before its
 * first save) gets the GH-8 v1 config as version 1 (docs/DECISIONS.md DEC-014).
 */

export interface HostelRules {
  config: RulesConfig;
  version: number;
}

export class RulesProvider {
  private readonly cache = new Map<string, { rules: HostelRules; until: number }>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly ttlMs = 60_000,
  ) {}

  async forHostel(hostelId: string): Promise<HostelRules> {
    const cached = this.cache.get(hostelId);
    if (cached && cached.until > Date.now()) return cached.rules;
    const row = await this.db
      .selectFrom('haven.hostel_rules')
      .select(['version', 'config'])
      .where('hostel_id', '=', hostelId)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();
    const rules: HostelRules = row
      ? { config: RulesConfigSchema.parse(row.config), version: row.version }
      : { config: GH8_RULES_CONFIG_V1, version: 1 };
    this.cache.set(hostelId, { rules, until: Date.now() + this.ttlMs });
    return rules;
  }

  invalidate(hostelId: string): void {
    this.cache.delete(hostelId);
  }
}
