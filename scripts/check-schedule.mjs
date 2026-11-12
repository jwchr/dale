// Owner-approved read-only schedule check (Nov 12, 2026). Manual main-only workflow mode.
// Reads the deployed schedule from Dale's Worker (public GET /v1/schedule) and NJ Transit's
// current G2 file, builds the candidate exactly as preparation does, and prints aggregate
// counts and service dates only. No Worker write, no Cloudflare credentials, no artifacts:
// the ZIP, token and raw feed never leave runner memory and are never logged.
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { authenticate, njtRequest } from '../worker/njt-client.ts';
import { parseDataset } from '../src/domain/dataset.ts';
import { localYmd } from '../src/domain/time.ts';
import { buildDataset } from './gtfs-lib.mjs';
import { readCanonicalBytes } from './enabled-continuity.mjs';
import { compareSchedules, plainVerdict, windowDays } from './schedule-compare.mjs';

let phase = 'preflight';
try {
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REPOSITORY !== 'jwchr/dale'
    || process.env.HISTORY_COLLECTION_MODE !== 'schedule-check') throw new Error('manual-main-required');
  phase = 'deployed-schedule-read';
  const deployed = await readCanonicalBytes(process.env);
  phase = 'authentication';
  const token = await authenticate(process.env);
  phase = 'static-download';
  const bytes = await njtRequest('getGTFS', { token }, 128 * 1024 * 1024, fetch, 120_000);
  phase = 'zip-decode';
  const needed = new Set(['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'frequencies.txt']);
  const zip = unzipSync(bytes, { filter: (entry) => needed.has(entry.name.split('/').pop()) });
  const files = Object.fromEntries(Object.entries(zip).map(([name, value]) => [name.split('/').pop(), strFromU8(value)]));
  phase = 'candidate-build';
  const sourceSHA256 = createHash('sha256').update(bytes).digest('hex');
  // Same converter options as scripts/prepare-live-worker.mjs; stop city labels do not affect the comparison.
  const candidate = buildDataset(files, { routeShortNames: ['163', '164', '165', '165T'], splitVariants: true, scheduledOnly: true,
    feedVersion: sourceSHA256.slice(0, 12), source: 'NJ Transit GTFS BUS G2' });
  parseDataset(candidate);
  phase = 'comparison';
  const today = localYmd(Date.now(), deployed.ds.meta.timezone);
  // Cover both calendars to their last date (at least 60 days, at most 366).
  const summary = compareSchedules(deployed.ds, candidate, { today, days: windowDays(deployed.ds, candidate, today) });
  console.log(`Schedule check (aggregate counts and dates only): ${JSON.stringify({ ...summary, sameSourceFile: summary.candidate.feedVersion === summary.deployed.feedVersion, deployedContext: deployed.context, checkerCommit: process.env.GITHUB_SHA })}`);
  console.log(`Plain summary: ${plainVerdict(summary)}`);
  console.log('Read-only: nothing on Dale\'s server was changed and no NJ Transit data was saved.');
} catch {
  // Only the fixed phase name; the error message is never printed.
  console.error(`Schedule check failed at ${phase}. No credentials, token or response details are logged. Nothing was changed.`);
  process.exitCode = 1;
}
