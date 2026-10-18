#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * Triggers the SDD §9.8 jobs by hand against the running demo database, so a presenter
 * doesn't have to wait for the schedule (docs/DEMO.md §I). The demo API (WORKER_ENABLED)
 * then delivers whatever the job produced through the outbox, exactly as it would at
 * the scheduled time.
 *
 *   pnpm --filter @haven/api run demo:job -- list
 *   pnpm --filter @haven/api run demo:job -- run <job>           e.g. run job_night_sweep
 *   pnpm --filter @haven/api run demo:job -- overstay <VISIT>    the visit's window ended 16 min ago
 *   pnpm --filter @haven/api run demo:job -- escalate <VISIT>    the overstay was flagged 31 min ago
 *   pnpm --filter @haven/api run demo:job -- gate-offline        every gate screen silent for 6 min
 *
 * Demo-only: it connects to the embedded, localhost-only demo database and nothing else.
 */
import path from 'node:path';
import { sql } from 'kysely';
import { createDb } from '../src/db/index.js';
import { SystemClock } from '../src/lib/clock.js';
import { LocalDiskMediaStorage } from '../src/gate/media.js';
import { ExpoPushSender } from '../src/notify/senders.js';
import { JobRunner, SDD_JOBS, type JobName } from '../src/jobs/runner.js';
import { DEMO_DATABASE_URL } from './demo-constants.js';

const db = createDb({ DATABASE_URL: DEMO_DATABASE_URL, DB_POOL_MAX: 2 });
const runner = new JobRunner({
  db,
  clock: new SystemClock(),
  mediaStorage: new LocalDiskMediaStorage(path.join(process.cwd(), '.demo-media')),
  push: new ExpoPushSender(),
});

async function visitByCode(code: string | undefined): Promise<string> {
  if (!code)
    throw new Error('Give a visit code, e.g. VDEM001 (shown on W-05 and in Search visits).');
  const row = await db
    .selectFrom('haven.visits')
    .select(['id', 'status'])
    .where('code', '=', code.toUpperCase())
    .executeTakeFirst();
  if (!row) throw new Error(`No visit ${code}.`);
  if (row.status !== 'inside')
    throw new Error(`${code} is ${row.status}; only a guest inside can overstay.`);
  return row.id;
}

async function main() {
  const [command, arg] = process.argv.slice(2).filter((a) => a !== '--');
  switch (command) {
    case 'run': {
      const job = SDD_JOBS.find((j) => j.fn === arg);
      if (!job) throw new Error(`Unknown job "${arg ?? ''}". Try: list`);
      await runner.run(job.fn as JobName);
      console.log(`Ran ${job.fn}.`);
      break;
    }
    case 'overstay': {
      // BR-13: overstaying from window_end + 15 min. Move the window back, then run.
      const id = await visitByCode(arg);
      await db
        .updateTable('haven.visits')
        .set({
          window_end: sql<string>`now() - interval '16 minutes'`,
          overstay_since: null,
          overstay_escalated_at: null,
        })
        .where('id', '=', id)
        .execute();
      await runner.run('job_flag_overstays');
      console.log(`${arg} is now overstaying: host push and guest SMS queued.`);
      break;
    }
    case 'escalate': {
      // FR-72: wardens are told 30 min after the flag.
      const id = await visitByCode(arg);
      await db
        .updateTable('haven.visits')
        .set({
          overstay_since: sql<string>`now() - interval '31 minutes'`,
          overstay_escalated_at: null,
        })
        .where('id', '=', id)
        .execute();
      await runner.run('job_flag_overstays');
      console.log(`${arg}: wardens' N-OVERSTAY-WARDEN queued.`);
      break;
    }
    case 'gate-offline': {
      // FR-29: silent for more than 5 min → one alert per warden per outage.
      const devices = await db
        .updateTable('haven.gate_devices')
        .set({ last_seen_at: sql<string>`now() - interval '6 minutes'` })
        .where('revoked_at', 'is', null)
        .returning('id')
        .execute();
      if (devices.length === 0) {
        console.log('No paired gate screen yet — pair one first (docs/DEMO.md step C).');
        break;
      }
      await runner.run('job_gate_offline');
      console.log(
        `${devices.length} gate screen(s) marked silent; N-GATE-OFFLINE queued for wardens.`,
      );
      break;
    }
    case 'list':
    default:
      console.log('Jobs (SDD §9.8):');
      for (const j of SDD_JOBS)
        console.log(
          `  ${j.fn.padEnd(22)} ${j.every ? `every ${j.every} min` : `daily ${j.dailyIst} IST`}`,
        );
      console.log('Shortcuts: overstay <VISIT>, escalate <VISIT>, gate-offline');
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void db.destroy());
