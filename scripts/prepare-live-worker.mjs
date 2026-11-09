// Deployment-time official static feed. ZIP, credentials and token never become artifacts or repo files.
import { isDeepStrictEqual } from 'node:util';
import { readActiveWorkerIdentity } from './worker-content-identity.mjs';
import { preservationPins, requireEnabledResources, readPreservedCanonical } from './enabled-continuity.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { authenticate, njtRequest } from '../worker/njt-client.ts';
import { parseDataset } from '../src/domain/dataset.ts';
import { buildDataset } from './gtfs-lib.mjs';
import { buildRouteGeometry } from './route-geometry.mjs';
import { addStopCities } from './stop-cities.mjs';
let phase = 'preflight';
try {
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REPOSITORY !== 'jwchr/dale') throw new Error('manual-main-required');
  const preserve = process.env.HISTORY_COLLECTION_MODE === 'preserve-enabled';
  let retained, identity;
  if (preserve) {
    phase = 'enabled-preservation-preflight';
    const pins = preservationPins(process.env);
    identity = await readActiveWorkerIdentity(process.env);
    requireEnabledResources(identity, pins);
    retained = await readPreservedCanonical(process.env);
    if (!isDeepStrictEqual(identity, await readActiveWorkerIdentity(process.env))) throw new Error('Active identity changed');
  }
  phase = 'authentication';
  const token = await authenticate(process.env);
  phase = 'static-download';
  const bytes = await njtRequest('getGTFS', { token }, 128 * 1024 * 1024, fetch, 120_000);
  phase = 'zip-decode';
  const needed = new Set(['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'frequencies.txt', 'shapes.txt']);
  const zip = unzipSync(bytes, { filter: (entry) => needed.has(entry.name.split('/').pop()) });
  const files = Object.fromEntries(Object.entries(zip).map(([name, value]) => [name.split('/').pop(), strFromU8(value)]));
  phase = 'corridor-validation';
  const sourceSHA256 = createHash('sha256').update(bytes).digest('hex');
  if (retained && sourceSHA256.slice(0, 12) !== retained.ds.meta.feedVersion) throw new Error('Current source requires independently reviewed migration');
  let ds = retained?.ds;
  if (!ds) {
    ds = buildDataset(files, { routeShortNames: ['163', '164', '165', '165T'], splitVariants: true, scheduledOnly: true,
      feedVersion: sourceSHA256.slice(0, 12), source: 'NJ Transit GTFS BUS G2' });
    ds.meta.realtime = { provider: 'njt-bus-g2' };
    ds = await addStopCities(ds);
    console.log(`Verified stop city labels: ${ds.stops.filter(s => s.city).length}/${ds.stops.length}. Missing or conflicting labels remain unknown.`);
  }
  parseDataset(ds);
  if (ds.meta.demo || ds.meta.transcribed || ds.trips.length < 10 || !ds.routes.some((r) => r.shortName === '165T') || !ds.stops.some((s) => s.terminal === 'PABT')) throw new Error('corridor-validation-failed');
  phase = 'geometry-validation';
  const geometry = buildRouteGeometry(files, ds, sourceSHA256);
  if (retained && !Object.keys(geometry.trips).length) throw new Error('No matched geometry; do not update an enabled recorder');
  mkdirSync(new URL('../worker/generated/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../worker/generated/corridor.json', import.meta.url), retained?.text ?? JSON.stringify(ds));
  writeFileSync(new URL('../worker/generated/route-geometry.json', import.meta.url), JSON.stringify(geometry));
  if (retained) writeFileSync(new URL('../worker/generated/preservation.json', import.meta.url), JSON.stringify({ v: 1, context: retained.context, identity, checkpoint: retained.checkpoint }), { mode: 0o600 });
  console.log(`Official G2 corridor prepared: ${ds.routes.length} variants, ${ds.trips.length} trips, ${ds.stops.length} stops.`);
} catch {
  console.error(`Official G2 corridor preparation failed at ${phase}. No credentials, token or response details are logged. Do not deploy.`);
  process.exitCode = 1;
}
