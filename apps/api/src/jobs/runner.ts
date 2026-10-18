import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import type { MediaStorage } from '../gate/media.js';
import type { PushSender } from '../notify/senders.js';
import { purgeDueMedia } from './media-purge.js';
import { checkPushReceipts } from '../notify/receipts.js';
import { processDeletionRequests } from '../account/deletion.js';

/**
 * Scheduler for the SDD §9.8 jobs plus the API-side workers they hand off to.
 *
 * - The SQL jobs: where `pg_cron` is installed (Supabase) it calls them and this runner
 *   skips them; elsewhere (local Postgres, demo, e2e) this runner calls the same
 *   idempotent functions on the same cadence (docs/DECISIONS.md DEC-014). Each is
 *   passed this process's Clock, so tests can set time exactly (DEC-015).
 * - The API-side workers always run here, because they need things the database
 *   doesn't have: photo storage ("the API worker deletes the files", §11.8), Expo
 *   receipts ("A job fetches receipts 15 min later", §9.7) and account deletion
 *   ("Within 7 days the worker ...", §16.6).
 *
 * Runs only where WORKER_ENABLED=true.
 */

export type JobName =
  | 'job_expire_walkins'
  | 'job_expire_approved'
  | 'job_flag_overstays'
  | 'job_gate_offline'
  | 'job_expire_sessions'
  | 'job_night_sweep'
  | 'job_retention'
  | 'job_daily_digest'
  | 'media_purge'
  | 'push_receipts'
  | 'account_deletion';

/** One literal statement per SQL job — no SQL is assembled from strings. */
const SQL_JOBS = {
  job_expire_walkins: (now: Date) => sql`select haven.job_expire_walkins(${now})`,
  job_expire_approved: (now: Date) => sql`select haven.job_expire_approved(${now})`,
  job_flag_overstays: (now: Date) => sql`select haven.job_flag_overstays(${now})`,
  job_gate_offline: (now: Date) => sql`select haven.job_gate_offline(${now})`,
  job_expire_sessions: (now: Date) => sql`select haven.job_expire_sessions(${now})`,
  job_night_sweep: (now: Date) => sql`select haven.job_night_sweep(${now})`,
  job_retention: (now: Date) => sql`select haven.job_retention(${now})`,
  // FR-60, team-approved addition to the catalogue (docs/DECISIONS.md DEC-016).
  job_daily_digest: (now: Date) => sql`select haven.job_daily_digest(${now})`,
} as const;
type SqlJobName = keyof typeof SQL_JOBS;

function isSqlJob(name: JobName): name is SqlJobName {
  return name in SQL_JOBS;
}

interface Job {
  fn: JobName;
  /** Minutes between runs, or a daily IST time "HH:MM". */
  every?: number;
  dailyIst?: string;
}

/** SDD §9.8 cadences; the API-side workers follow the job that feeds them. */
export const SDD_JOBS: Job[] = [
  { fn: 'job_expire_walkins', every: 1 },
  { fn: 'job_expire_approved', every: 5 },
  { fn: 'job_flag_overstays', every: 5 },
  { fn: 'job_gate_offline', every: 5 },
  { fn: 'job_expire_sessions', every: 60 },
  { fn: 'job_night_sweep', dailyIst: '22:00' },
  { fn: 'job_retention', dailyIst: '03:00' },
  { fn: 'job_daily_digest', dailyIst: '08:00' },
  { fn: 'media_purge', every: 60 },
  { fn: 'push_receipts', every: 5 },
  { fn: 'account_deletion', every: 15 },
];

function istHhMm(d: Date): { hhmm: string; date: string } {
  const ist = new Date(d.getTime() + 5.5 * 3_600_000); // Asia/Kolkata has no DST
  return { hhmm: ist.toISOString().slice(11, 16), date: ist.toISOString().slice(0, 10) };
}

export interface JobRunnerDeps {
  db: Kysely<Database>;
  clock: Clock;
  mediaStorage: MediaStorage;
  push: PushSender;
  logger?: Pick<Logger, 'warn' | 'error' | 'info'>;
}

export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private minute = 0;
  private readonly lastDaily = new Map<string, string>();
  /** True when pg_cron runs the SQL jobs, so this runner only runs the API-side ones. */
  private cronOwnsSqlJobs = false;

  constructor(private readonly deps: JobRunnerDeps) {}

  /** Starts the one-minute loop. Returns false when pg_cron owns the SQL jobs. */
  async start(): Promise<boolean> {
    const cron = await sql<{
      n: number;
    }>`select count(*)::int as n from pg_extension where extname = 'pg_cron'`.execute(this.deps.db);
    this.cronOwnsSqlJobs = (cron.rows[0]?.n ?? 0) > 0;
    this.timer = setInterval(() => void this.tick(), 60_000);
    return !this.cronOwnsSqlJobs;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scheduler minute (exported for tests). Returns the jobs that ran. */
  async tick(): Promise<JobName[]> {
    const ran: JobName[] = [];
    const now = this.deps.clock.now();
    const { hhmm, date } = istHhMm(now);
    for (const job of SDD_JOBS) {
      if (this.cronOwnsSqlJobs && isSqlJob(job.fn)) continue;
      const due = job.every
        ? this.minute % job.every === 0
        : hhmm >= (job.dailyIst ?? '99:99') && this.lastDaily.get(job.fn) !== date;
      if (!due) continue;
      try {
        await this.run(job.fn, now);
        if (job.dailyIst) this.lastDaily.set(job.fn, date);
        ran.push(job.fn);
      } catch (err) {
        this.deps.logger?.error({ err, job: job.fn }, 'scheduled job failed');
      }
    }
    this.minute += 1;
    return ran;
  }

  /** Runs one job now, whatever its schedule (tests and the demo's manual trigger). */
  async run(name: JobName, now: Date = this.deps.clock.now()): Promise<void> {
    if (isSqlJob(name)) {
      await SQL_JOBS[name](now).execute(this.deps.db);
      // The files of whatever retention just made due go in the same pass (§11.8).
      if (name === 'job_retention') await this.run('media_purge', now);
      return;
    }
    const { db, clock, mediaStorage, push, logger } = this.deps;
    if (name === 'media_purge') await purgeDueMedia({ db, storage: mediaStorage, now, logger });
    if (name === 'push_receipts') await checkPushReceipts({ db, push, now, logger });
    if (name === 'account_deletion')
      await processDeletionRequests({ db, storage: mediaStorage, clock, logger });
  }
}
