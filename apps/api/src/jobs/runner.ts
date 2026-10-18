import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';

/**
 * Fallback scheduler for the SDD §9.8 jobs when `pg_cron` isn't installed (local Postgres,
 * the demo and e2e databases). It calls the same idempotent SQL functions on the same
 * cadence, so behaviour matches Supabase; when pg_cron is present it does nothing
 * (docs/DECISIONS.md DEC-014). Runs only where WORKER_ENABLED=true.
 */

type JobName =
  | 'job_expire_walkins'
  | 'job_expire_approved'
  | 'job_flag_overstays'
  | 'job_gate_offline'
  | 'job_expire_sessions'
  | 'job_night_sweep'
  | 'job_retention';

/** One literal statement per job — no SQL is assembled from strings. */
const JOB_SQL: Record<JobName, ReturnType<typeof sql>> = {
  job_expire_walkins: sql`select haven.job_expire_walkins()`,
  job_expire_approved: sql`select haven.job_expire_approved()`,
  job_flag_overstays: sql`select haven.job_flag_overstays()`,
  job_gate_offline: sql`select haven.job_gate_offline()`,
  job_expire_sessions: sql`select haven.job_expire_sessions()`,
  job_night_sweep: sql`select haven.job_night_sweep()`,
  job_retention: sql`select haven.job_retention()`,
};

interface Job {
  fn: JobName;
  /** Minutes between runs, or a daily IST time "HH:MM". */
  every?: number;
  dailyIst?: string;
}

export const SDD_JOBS: Job[] = [
  { fn: 'job_expire_walkins', every: 1 },
  { fn: 'job_expire_approved', every: 5 },
  { fn: 'job_flag_overstays', every: 5 },
  { fn: 'job_gate_offline', every: 5 },
  { fn: 'job_expire_sessions', every: 60 },
  { fn: 'job_night_sweep', dailyIst: '22:00' },
  { fn: 'job_retention', dailyIst: '03:00' },
];

function istHhMm(d: Date): { hhmm: string; date: string } {
  const ist = new Date(d.getTime() + 5.5 * 3_600_000); // Asia/Kolkata has no DST
  return { hhmm: ist.toISOString().slice(11, 16), date: ist.toISOString().slice(0, 10) };
}

export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private minute = 0;
  private readonly lastDaily = new Map<string, string>();

  constructor(
    private readonly deps: {
      db: Kysely<Database>;
      clock: Clock;
      logger?: Pick<Logger, 'warn' | 'error'>;
    },
  ) {}

  async start(): Promise<boolean> {
    const cron = await sql<{
      n: number;
    }>`select count(*)::int as n from pg_extension where extname = 'pg_cron'`.execute(this.deps.db);
    if ((cron.rows[0]?.n ?? 0) > 0) return false;
    this.timer = setInterval(() => void this.tick(), 60_000);
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scheduler minute (exported for tests). */
  async tick(): Promise<string[]> {
    const ran: string[] = [];
    const { hhmm, date } = istHhMm(this.deps.clock.now());
    for (const job of SDD_JOBS) {
      const due = job.every
        ? this.minute % job.every === 0
        : hhmm >= (job.dailyIst ?? '99:99') && this.lastDaily.get(job.fn) !== date;
      if (!due) continue;
      try {
        await JOB_SQL[job.fn].execute(this.deps.db);
        if (job.dailyIst) this.lastDaily.set(job.fn, date);
        ran.push(job.fn);
      } catch (err) {
        this.deps.logger?.error({ err, job: job.fn }, 'scheduled job failed');
      }
    }
    this.minute += 1;
    return ran;
  }
}
