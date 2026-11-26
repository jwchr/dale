import { makeRollbackReference, referenceDigest } from './enabled-rollback.mjs';
// Deployment-time official static feed. ZIP, credentials and token never become artifacts or repo files.
import { isDeepStrictEqual } from 'node:util';
import { readActiveWorkerIdentity } from './worker-content-identity.mjs';
import { preservationPins, requireEnabledResources, readPreservedCanonical, observedCanonicalIdentity } from './enabled-continuity.mjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { authenticate, njtRequest } from '../worker/njt-client.ts';
import { parseDataset } from '../src/domain/dataset.ts';
import { buildDataset } from './gtfs-lib.mjs';
import { buildRouteGeometryWithReport, GeometryError, geometryFailureDiagnostic } from './route-geometry.mjs';
import { addStopCities } from './stop-cities.mjs';
import { addOfficialFares, addZoneChecks } from './official-fares.mjs';
import { localYmd } from '../src/domain/time.ts';
import { compareSchedules, plainVerdict, windowDays } from './schedule-compare.mjs';
import { requireCoverage, requireNoShorter, rolloverCapacity } from './schedule-rollover.mjs';
import { buildRescueSchedule } from './rescue-schedule.mjs';
// Owner confirmed 2026-11-12 (D68): in rollover-enabled mode only, a route-geometry failure
// ships the new schedule with route distance off (never straight-line distance) instead of
// stopping the weekly rollover; the aggregate diagnostic is printed so the cause can be fixed.
// Set this to false to make rollover fail closed on geometry like every other mode.
const ROLLOVER_SHIPS_WITHOUT_GEOMETRY = true;
/** Rollover-only geometry fallback: aggregate diagnostic, then null geometry (distance off). */
function rolloverGeometryFallback(error) {
  if (!ROLLOVER_SHIPS_WITHOUT_GEOMETRY) throw error;
  console.log(`Geometry diagnostic (aggregate counts only): ${JSON.stringify(geometryFailureDiagnostic(error))}`);
  console.log('Route distance stays off for this schedule; the schedule rollover continues.');
  return null;
}
let phase = 'preflight';
try {
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REPOSITORY !== 'jwchr/dale') throw new Error('manual-main-required');
  const preserve = process.env.HISTORY_COLLECTION_MODE === 'preserve-enabled';
  const rollover = process.env.HISTORY_COLLECTION_MODE === 'rollover-enabled';
  let retained, identity;
  if (preserve || rollover) {
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
  const needed = new Set(['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'frequencies.txt', 'shapes.txt', 'fare_attributes.txt', 'fare_rules.txt']);
  const sourceFileNames = [];
  const zip = unzipSync(bytes, { filter: (entry) => { const name = entry.name.split('/').pop(); sourceFileNames.push(name); return needed.has(name); } });
  const files = Object.fromEntries(Object.entries(zip).map(([name, value]) => [name.split('/').pop(), strFromU8(value)]));
  phase = 'corridor-validation';
  const sourceSHA256 = createHash('sha256').update(bytes).digest('hex');
  if (preserve && sourceSHA256.slice(0, 12) !== retained.ds.meta.feedVersion) throw new Error('Current source requires independently reviewed migration');
  if (rollover) {
    // An unchanged file needs no rollover; preserve-enabled is the reviewed path for it.
    phase = 'rollover-same-schedule-file';
    if (sourceSHA256.slice(0, 12) === retained.ds.meta.feedVersion) throw new Error('Unchanged source: use preserve-enabled');
    phase = 'corridor-validation';
  }
  let ds = preserve ? retained.ds : undefined;
  if (!ds) {
    ds = buildDataset(files, { routeShortNames: ['163', '164', '165', '165T'], splitVariants: true, scheduledOnly: true,
      feedVersion: sourceSHA256.slice(0, 12), source: 'NJ Transit GTFS BUS G2' });
    ds.meta.realtime = { provider: 'njt-bus-g2' };
    ds = await addStopCities(ds);
    // Printed route 165 fare zones on official stops (#31 step 2, #238). Aggregate counts only; below the anchor floor no fares are added.
    const fares = addOfficialFares(ds, JSON.parse(readFileSync(new URL('../data/t0165/transcription.json', import.meta.url), 'utf8')));
    ds = fares.ds;
    console.log(`Printed fare zones: ${fares.report.added ? 'added' : 'not added'}; anchors ${fares.report.anchors.toWestwood}/${fares.report.of.toWestwood} to Westwood, ${fares.report.anchors.toNewYork}/${fares.report.of.toNewYork} to New York; stops with one zone ${fares.report.oneZone}, two zones ${fares.report.twoZones}, none ${fares.report.noZone}.`);
    const checksFile = new URL('../data/t0165/zone-checks.json', import.meta.url);
    if (existsSync(checksFile)) {
      const checks = addZoneChecks(ds, JSON.parse(readFileSync(checksFile, 'utf8')));
      ds = checks.ds;
      const r = checks.report;
      if (r.stale) console.log('Trip planner zone checks: stale, not applied.');
      else console.log(`Trip planner zone checks: entries ${r.entries}, applied ${r.applied}, narrowed ${r.narrowed}, filled ${r.filled}, same ${r.same}, conflicts ${r.conflicts}, disagree ${r.disagree}, unmatched ${r.unmatched}.`);
    } else console.log('Trip planner zone checks: no checks present.');
    console.log(`Verified stop city labels: ${ds.stops.filter(s => s.city).length}/${ds.stops.length}. Missing or conflicting labels remain unknown.`);
  }
  parseDataset(ds);
  if (ds.meta.demo || ds.meta.transcribed || ds.trips.length < 10 || !ds.routes.some((r) => r.shortName === '165T') || !ds.stops.some((s) => s.terminal === 'PABT')) throw new Error('corridor-validation-failed');
  let rolloverReceipt;
  if (rollover) {
    const next = observedCanonicalIdentity(JSON.stringify(ds));
    phase = 'rollover-coverage';
    const today = localYmd(Date.now(), ds.meta.timezone);
    const coverage = requireCoverage(ds, today);
    console.log(`Rollover coverage: every service date from ${coverage.from} to ${coverage.to} has corridor trips (fewest on one date: ${coverage.minTripsPerDate}).`);
    phase = 'rollover-end-date';
    const ends = requireNoShorter(retained.ds, ds);
    console.log(`Rollover end dates: live file through ${ends.currentEnd}, new file through ${ends.nextEnd}.`);
    phase = 'rollover-comparison';
    const summary = compareSchedules(retained.ds, ds, { today, days: windowDays(retained.ds, ds, today) });
    console.log(`Schedule rollover comparison (aggregate counts and dates only): ${JSON.stringify(summary)}`);
    console.log(`Plain summary: ${plainVerdict(summary)}`);
    phase = 'rollover-capacity';
    const capacity = rolloverCapacity(retained.checkpoint, next.text);
    console.log(`Rollover capacity (aggregate only): ${JSON.stringify(capacity.summary)}`);
    if (!capacity.ok) throw new Error('rollover-capacity-refused');
    rolloverReceipt = JSON.stringify({ v: 1, kind: 'rollover', fromContext: retained.context, toFeedVersion: ds.meta.feedVersion, toContext: next.context, identity, checkpoint: retained.checkpoint });
    if (Buffer.byteLength(rolloverReceipt) > 32_000) throw new Error('Oversized receipt');
  }
  phase = 'geometry-validation';
  let geometry;
  try {
    const report = buildRouteGeometryWithReport(files, ds, sourceSHA256);
    geometry = report.geometry;
    if (retained && !Object.keys(geometry.trips).length) throw new GeometryError('no-matched-trips', 'No matched geometry; do not update an enabled recorder', report.counts);
    const { matchedTrips, outputShapes, unitFactor } = report.counts;
    if (matchedTrips) console.log(`Route geometry (aggregate counts only): ${JSON.stringify({ matchedTrips, outputShapes, unitFactor })}`);
  } catch (error) {
    if (!rollover) throw error;
    geometry = rolloverGeometryFallback(error);
  }
  // Wider rescue schedule (#32, #31): a separate delivery file, built from the same official download and
  // feed version as the corridor schedule. It never changes the corridor schedule or the history context,
  // and any failure here ships no wider file (Rescue then says so) instead of stopping this preparation.
  phase = 'rescue-schedule';
  let rescue = null;
  try {
    const built = buildRescueSchedule(files, ds, { sourceFileNames });
    rescue = built.schedule;
    console.log(`Wider rescue schedule (aggregate counts and route numbers only): ${JSON.stringify(built.report)}`);
  } catch {
    console.log('Wider rescue schedule could not be built; Rescue will say other routes are unavailable. The corridor schedule is unaffected.');
  }
  // D84 (Jeff, Nov 26, 2026: "All the data, save all the data."): no region file, so every statewide bus
  // response is saved whole. The D83 region filter stays in the code, unused, for a later decision.
  const region = null;
  console.log('Raw bus region: statewide (D84); every bus response is saved whole.');
  phase = 'generated-files';
  mkdirSync(new URL('../worker/generated/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../worker/generated/corridor.json', import.meta.url), preserve ? retained.text : JSON.stringify(ds));
  writeFileSync(new URL('../worker/generated/rescue-schedule.json', import.meta.url), JSON.stringify(rescue));
  writeFileSync(new URL('../worker/generated/region-routes.json', import.meta.url), JSON.stringify(region));
  writeFileSync(new URL('../worker/generated/route-geometry.json', import.meta.url), JSON.stringify(geometry));
  if (rollover) writeFileSync(new URL('../worker/generated/rollover.json', import.meta.url), rolloverReceipt, { mode: 0o600 });
  if (preserve) {
    const reference = makeRollbackReference(identity, retained.context);
    console.log(`Prior enabled rollback reference (non-secret hashes only; not review/deployment clearance): ${JSON.stringify(reference)}`);
    console.log(`Rollback reference digest: ${referenceDigest(reference)}`);
  }
  if (preserve) writeFileSync(new URL('../worker/generated/preservation.json', import.meta.url), JSON.stringify({ v: 1, context: retained.context, identity, checkpoint: retained.checkpoint }), { mode: 0o600 });
  console.log(`Official G2 corridor prepared: ${ds.routes.length} variants, ${ds.trips.length} trips, ${ds.stops.length} stops.`);
} catch (error) {
  // Only the allowlisted reason and fixed-key aggregate integers; the error message is never printed.
  if (error instanceof GeometryError) console.error(`Geometry diagnostic (aggregate counts only): ${JSON.stringify(geometryFailureDiagnostic(error))}`);
  console.error(`Official G2 corridor preparation failed at ${phase}. No credentials, token or response details are logged. Do not deploy.`);
  process.exitCode = 1;
}
