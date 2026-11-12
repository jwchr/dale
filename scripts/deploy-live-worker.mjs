import { qualifyEnabled } from './enabled-qualification.mjs';
import { rollbackEnabled } from './enabled-rollback.mjs';
import { isDeepStrictEqual } from 'node:util';
import { preservationPins, requireEnabledResources, canonicalIdentity, observedCanonicalIdentity, readCanonicalBytes, readPreservedCanonical, readEnabledCheckpoint, readCollection, preservesEnabled, CODE_DEFERRAL_MS, waitForTransitionProgress, waitForRolloverProgress, waitForServedContext } from './enabled-continuity.mjs';
import { rolloverCapacity } from './schedule-rollover.mjs';
// Manual main-only deployment. Secret values and raw CLI/API errors never leave the runner.
import { waitForReadiness } from './collection-readiness.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { safeNjtFailure, NjtError } from '../worker/njt-client.ts';
import { liveApiUrl, parseLiveSnapshot } from '../src/domain/liveBus.ts';
import { stopHistoryCollection, safeStopFailure } from './stop-history-collection.mjs';
import { readActiveWorkerIdentity, workerProofDiagnostic, workerProofError } from './worker-content-identity.mjs';
import { verifyUploadedWorker } from './worker-deployment-proof.mjs';
import { disabledArchiveEvidence, preservesArchiveEvidence } from './disabled-archive-evidence.mjs';
let temporary;
const ROLLOVER_RECOVERY = 'Schedule rollover not proven; no automatic rollback or stop was attempted. Recovery: if the old schedule is still served, a reviewed rollover-enabled re-run. If the new schedule is served and collection is healthy, preserve-enabled with the pins qualify-enabled reports. If the new context could not be stored (rollover-context-admission-failed), qualify-enabled, preserve-enabled and rollover-enabled all refuse and the actor retries only when rebuilt: after the cause clears (the daily write budget resets at 00:00 UTC; byte capacity needs a reviewed fix), an owner-approved enabled run rebuilds from the current file and redeploys, which rebuilds the actor (untested in production). The existing disabled choice stops collection and preserves all evidence at any time.';
async function run() {
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REPOSITORY !== 'jwchr/dale') throw workerProofError('manual-main-required');
  const collectionMode = process.env.HISTORY_COLLECTION_MODE || 'disabled';
  if (!['disabled', 'enabled', 'restore-disabled', 'preserve-enabled', 'rollover-enabled', 'rollback-enabled', 'qualify-enabled'].includes(collectionMode)) throw workerProofError('collection-mode-invalid');
  if (collectionMode === 'qualify-enabled') {
    const receipt = await qualifyEnabled(process.env);
    console.log('Enabled qualification observation: ' + JSON.stringify(receipt));
    console.log('Observation only: no preparation, actor-version attestation, rollback eligibility or operation permission established.');
    return;
  }
  if (collectionMode === 'rollback-enabled') {
    if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '')) throw workerProofError('reviewed-source-identity-required');
    const result = await rollbackEnabled(process.env);
    console.log(`Post-deferral proof: acknowledgedAt=${result.acknowledgedAt} boundaryAt=${result.boundaryAt} nativeAttemptAt=${result.nativeAttemptAt} archiveSuccessAt=${result.archiveSuccessAt}.`);
    console.log(`Pinned enabled rollback checked over ${result.durationMs}ms; native completion/archive advanced and exact canonical context/resources/content retained. Interrupted-attempt backlog ${result.interruptionsBefore}/${result.interruptionsAfter}; zero-gap and every-object durability are not inferred.`);
    return;
  }
  if (collectionMode === 'disabled') {
    await stopHistoryCollection(process.env);
    return;
  }
  const preserve = collectionMode === 'preserve-enabled', rollover = collectionMode === 'rollover-enabled';
  // Both pinned modes keep the running enabled collector: no secrets file, deferred actor update.
  const pinned = preserve || rollover;
  const targetEnabled = collectionMode === 'enabled' || pinned;
  const pins = pinned ? preservationPins(process.env) : undefined;
  const deploymentStartedAt = Date.now();
  const url = liveApiUrl(process.env.DALE_WORKER_URL);
  let ds, localText;
  try { localText = readFileSync(new URL('../worker/generated/corridor.json', import.meta.url), 'utf8'); ds = JSON.parse(localText); }
  catch { throw workerProofError('schedule-preflight-failed'); }
  if (!url || !process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID || (!pinned && (!process.env.NJT_API_USERNAME || !process.env.NJT_API_PASSWORD))
    || ds.meta?.source !== 'NJ Transit GTFS BUS G2' || !/^[a-f0-9]{12}$/.test(ds.meta.feedVersion) || ds.meta.realtime?.provider !== 'njt-bus-g2' || ds.meta.demo) throw workerProofError('configuration-invalid');
  if (!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '')) throw workerProofError('reviewed-source-identity-required');
  const before = await readActiveWorkerIdentity(process.env);
  if (!before.bindings.some(b => b.name === 'FEED' && b.type === 'durable_object_namespace' && typeof b.namespace_id === 'string' && b.namespace_id)
    || !before.bindings.some(b => b.name === 'HISTORY_ARCHIVE' && b.type === 'r2_bucket' && b.bucket_name === 'dale-history')
    || !['NJT_API_USERNAME', 'NJT_API_PASSWORD'].every(name => before.bindings.some(b => b.name === name && b.type === 'secret_text'))) throw workerProofError('existing-resource-identity-required');
  let config;
  try { config = JSON.parse(readFileSync(new URL('../worker/wrangler.jsonc', import.meta.url), 'utf8')); }
  catch { throw workerProofError('hosting-config-preflight-failed'); }
  const existingNames = ['FEED', 'HISTORY_ARCHIVE', 'NJT_API_USERNAME', 'NJT_API_PASSWORD', 'HISTORY_COLLECTION'];
  if (config.upload_source_maps !== false || config.name !== 'dale-live' || config.main !== 'index.ts' || config.vars?.HISTORY_COLLECTION !== 'disabled'
    || config.compatibility_date !== before.runtime.compatibility_date
    || JSON.stringify(config.compatibility_flags) !== JSON.stringify(before.runtime.compatibility_flags)
    || config.migrations?.length !== 1 || config.migrations[0].tag !== before.runtime.migration_tag
    || before.bindings.some(b => !existingNames.includes(b.name))) throw workerProofError('worker-existing-configuration-mismatch');
  let continuityBefore;
  if (preserve) {
    requireEnabledResources(before, pins);
    let receipt;
    try {
      const text = readFileSync(new URL('../worker/generated/preservation.json', import.meta.url), 'utf8');
      if (Buffer.byteLength(text) > 32_000) throw new Error('Oversized checkpoint');
      receipt = JSON.parse(text);
    } catch { throw workerProofError('enabled-continuity-unverified'); }
    if (receipt.v !== 1 || receipt.context !== pins.context || before.versionId !== pins.versionId
      || !isDeepStrictEqual(receipt.identity, before)
      || !before.bindings.some(b => b.name === 'HISTORY_COLLECTION' && b.type === 'plain_text' && b.text === 'enabled')) throw workerProofError('enabled-continuity-unverified');
    const canonical = canonicalIdentity(JSON.stringify(ds), pins.context), retained = await readPreservedCanonical(process.env);
    if (canonical.text !== retained.text) throw workerProofError('enabled-continuity-unverified');
    preservesEnabled(receipt.checkpoint, retained.checkpoint);
    continuityBefore = retained.checkpoint;
    // Keep version/module/runtime/resource equality bracketed across public readbacks.
    if (!isDeepStrictEqual(before, await readActiveWorkerIdentity(process.env))) throw workerProofError('enabled-continuity-unverified');
  }
  let next, previousContext;
  if (rollover) {
    requireEnabledResources(before, pins);
    let receipt;
    try {
      const text = readFileSync(new URL('../worker/generated/rollover.json', import.meta.url), 'utf8');
      if (Buffer.byteLength(text) > 32_000) throw new Error('Oversized receipt');
      receipt = JSON.parse(text);
    } catch { throw workerProofError('rollover-receipt-unverified'); }
    if (!receipt || receipt.v !== 1 || receipt.kind !== 'rollover' || receipt.fromContext !== pins.context || before.versionId !== pins.versionId
      || !isDeepStrictEqual(receipt.identity, before)
      || !before.bindings.some(b => b.name === 'HISTORY_COLLECTION' && b.type === 'plain_text' && b.text === 'enabled')) throw workerProofError('rollover-receipt-unverified');
    // The old schedule must still be served: nothing has rolled over since preparation.
    const retained = await readPreservedCanonical(process.env);
    try { next = observedCanonicalIdentity(localText); } catch { throw workerProofError('rollover-schedule-invalid'); }
    if (next.text === retained.text || next.ds.meta.feedVersion !== receipt.toFeedVersion || next.context !== receipt.toContext
      || next.ds.meta.feedVersion === retained.ds.meta.feedVersion) throw workerProofError('rollover-schedule-invalid');
    // Nothing reset since preparation, at the OLD schedule version.
    preservesEnabled(receipt.checkpoint, retained.checkpoint);
    // Re-check capacity against the fresh checkpoint, a few minutes newer than preparation's.
    let capacity;
    try { capacity = rolloverCapacity(retained.checkpoint, next.text); } catch { throw workerProofError('rollover-capacity-refused'); }
    if (!capacity.ok) throw workerProofError('rollover-capacity-refused');
    continuityBefore = retained.checkpoint; previousContext = retained.context;
    if (!isDeepStrictEqual(before, await readActiveWorkerIdentity(process.env))) throw workerProofError('enabled-continuity-unverified');
  }
  let retained, archiveBefore;
  if (!targetEnabled) {
    const readback = await fetch(url + '/v1/collection', { signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
    retained = readback.ok ? (await readback.json()).collection : undefined;
    if (!retained || retained.enabled !== false || retained.reason !== 'disabled' || retained.alarmAt !== null || retained.error
      || !['observations', 'batches', 'bytes'].every(key => Number.isSafeInteger(retained[key]) && retained[key] >= 0)
      || !before.bindings.some(b => b.name === 'HISTORY_COLLECTION' && b.type === 'plain_text' && b.text === 'disabled')) throw workerProofError('restore-disabled-precondition');
    archiveBefore = disabledArchiveEvidence(retained.archive);
  }
  temporary = mkdtempSync(join(tmpdir(), 'dale-worker-secrets-'));
  const secrets = join(temporary, 'secrets.json');
  if (!pinned) writeFileSync(secrets, JSON.stringify({ NJT_API_USERNAME: process.env.NJT_API_USERNAME, NJT_API_PASSWORD: process.env.NJT_API_PASSWORD }), { mode: 0o600, flag: 'wx' });
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', 'worker/wrangler.jsonc', ...(pinned ? [] : ['--secrets-file', secrets]),
    ...(pinned ? ['--durable-objects-code-update-mode', `deferred ${CODE_DEFERRAL_MS / 1000}s`] : []),
    '--var', `HISTORY_COLLECTION:${targetEnabled ? 'enabled' : 'disabled'}`, '--outdir', join(temporary, 'uploaded')], {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 240_000,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error' },
  });
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '') + String(result.stdout ?? '');
    if (/10000|Authentication error/i.test(detail)) console.error('Cloudflare denied the deployment credential. App activation is held.');
    else if (/10021|startup/i.test(detail)) console.error('Cloudflare rejected Worker startup. App activation is held.');
    else if (/limit|quota/i.test(detail)) console.error('Cloudflare reported a resource limit. Do not upgrade automatically.');
    throw workerProofError('deployment-failed');
  }
  const mutationAcknowledgedAt = Date.now();
  const uploaded = await verifyUploadedWorker(process.env, join(temporary, 'uploaded'), before);
  if (!uploaded.bindings.some(b => b.name === 'HISTORY_COLLECTION' && b.type === 'plain_text' && b.text === (targetEnabled ? 'enabled' : 'disabled'))) throw workerProofError('uploaded-mode-invalid');
  if (!pinned) {
    const health = await fetch(url + '/health', { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!health.ok || (await health.json()).feedVersion !== ds.meta.feedVersion) throw workerProofError('health-check-failed');
  }
  console.log('Reviewed upload artifact matches all active executable/data modules; runtime and other binding descriptors preserved.');
  if (!targetEnabled) {
    await stopHistoryCollection(process.env);
    const check = await fetch(url + '/v1/collection', { signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
    const current = check.ok ? (await check.json()).collection : undefined;
    if (!current || current.enabled !== false || current.reason !== 'disabled' || current.alarmAt !== null || current.error
      || current.lastAttemptAt !== retained.lastAttemptAt || current.completedAttempt !== retained.completedAttempt
      || !Number.isSafeInteger(current.observations) || current.observations !== retained.observations
      || !Number.isSafeInteger(current.batches) || current.batches !== retained.batches
      || !Number.isSafeInteger(current.bytes) || current.bytes < retained.bytes
      || !preservesArchiveEvidence(archiveBefore, disabledArchiveEvidence(current.archive))) throw workerProofError('restored-evidence-unverified');
    if (archiveBefore.kind === 'unreported') console.log('Disabled health omits archive receipt counters and backlog: unknown remains unknown. Same private bucket binding preserved; no archive-count or object-durability result inferred.');
    console.log('Known reviewed code restored disabled; retained journal evidence and strict module/stop proof passed. Private archive receipts need separate readback. Original historical code identity remains unknown. Resume requires a separate authorized action.');
    return;
  }
  if (preserve) {
    const after = await readCanonicalBytes(process.env, { expectedContext: pins.context });
    if (after.text !== JSON.stringify(ds)) throw workerProofError('enabled-continuity-unverified');
    const transition = await waitForTransitionProgress(continuityBefore,
      timeoutMs => readEnabledCheckpoint(process.env, ds.meta.feedVersion, { timeoutMs }), mutationAcknowledgedAt);
    const checkpoint = transition.checkpoint;
    if (!isDeepStrictEqual(uploaded, await readActiveWorkerIdentity(process.env))) throw workerProofError('enabled-continuity-unverified');
    console.log(`Post-deferral proof: acknowledgedAt=${transition.acknowledgedAt} boundaryAt=${transition.boundaryAt} nativeAttemptAt=${checkpoint.completedAttempt} nativeSuccessAt=${checkpoint.lastSuccessAt} archiveSuccessAt=${checkpoint.archive.lastSuccessAt}.`);
    console.log('Existing enabled collector preserved: exact canonical bytes/context, runtime/resources/bindings, native alarm and advancing verified archive checked. No demand feed request, activation, stop or rate change.');
    console.log(`Enabled preservation observation interval: ${continuityBefore.at} to ${checkpoint.at} (${checkpoint.at - continuityBefore.at}ms). This is bounded observation, not sustained continuity.`);
    console.log(`Interrupted-attempt backlog before/after: ${continuityBefore.pendingInterruptionCount}/${checkpoint.pendingInterruptionCount}. This is not proof of zero interruption or every stored object. Separate operator evidence remains required.`);
    console.log('Distance geometry/current GPS/public acceptance remains separate. On failure, hold release; no automatic stop or rollback is attempted. Prior pinned Worker identity remains the operator rollback reference; preserve enabled binding, namespace, bucket and every evidence object.');
    return;
  }
  if (rollover) {
    const served = await waitForServedContext(process.env, next.context, previousContext);
    if (served.text !== next.text) throw workerProofError('rollover-schedule-not-served');
    const transition = await waitForRolloverProgress(continuityBefore,
      timeoutMs => readCollection(process.env, { timeoutMs }), next.ds.meta.feedVersion, mutationAcknowledgedAt);
    const checkpoint = transition.checkpoint;
    if (!isDeepStrictEqual(uploaded, await readActiveWorkerIdentity(process.env))) throw workerProofError('enabled-continuity-unverified');
    console.log(`Post-deferral proof: acknowledgedAt=${transition.acknowledgedAt} boundaryAt=${transition.boundaryAt} nativeAttemptAt=${checkpoint.completedAttempt} nativeSuccessAt=${checkpoint.lastSuccessAt} archiveSuccessAt=${checkpoint.archive.lastSuccessAt}.`);
    console.log(`Schedule rollover proven: ${continuityBefore.feedVersion} to ${checkpoint.feedVersion}. The new schedule is served, its context was stored, and native collection and verified archiving advanced under it with no cumulative counter or limit reset.`);
    console.log(`Evidence before/after: observations ${continuityBefore.observations}/${checkpoint.observations}, batches ${continuityBefore.batches}/${checkpoint.batches}, verified archive objects ${continuityBefore.archive.verifiedObjects}/${checkpoint.archive.verifiedObjects}, interrupted-attempt backlog ${continuityBefore.pendingInterruptionCount}/${checkpoint.pendingInterruptionCount}.`);
    console.log('Not proven: per-schedule counters (none are exposed), that every old batch archived under the old context, or zero interruption. Rollback-enabled cannot cross schedules.');
    console.log(`Next rollover pins: expected_worker_version=${uploaded.versionId} canonical_context_key=${next.context}`);
    return;
  }
  const status = await fetch(url + '/v1/status', { signal: AbortSignal.timeout(45_000), redirect: 'error', cache: 'no-store' });
  if (!status.ok) throw workerProofError('live-check-failed');
  const profile = await status.json();
  const v = profile.vehicles?.state, u = profile.updates?.state;
  const allowed = ['ok', 'stale', 'unavailable', 'invalid'];
  if (!allowed.includes(v) || !allowed.includes(u) || profile.feedVersion !== ds.meta.feedVersion || !Number.isSafeInteger(profile.reportingBuses)) throw workerProofError('invalid-profile');
  let collection = profile.collection;
  if (collectionMode === 'enabled') {
    // Read-only collection health does not create a demand observation. Wait for
    // the native alarm's independently verified context+evidence archive.
    const ready = state => state?.archive?.configured === true && state.archive.reason === 'ready'
      && state.archive.verifiedObjects >= 2 && state.archive.lastSuccessAt >= deploymentStartedAt && state.scheduleContextStored;
    if (!ready(collection)) collection = await waitForReadiness(async timeoutMs => {
      const check = await fetch(url + '/v1/collection', { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store' });
      if (!check.ok) throw workerProofError('collection-health-failed');
      const current = (await check.json()).collection;
      return ready(current) ? current : undefined;
    });
    if (collection?.archive?.configured !== true || collection.archive.reason !== 'ready' || collection.archive.verifiedObjects < 2
      || collection.archive.lastSuccessAt < deploymentStartedAt || !collection.scheduleContextStored) throw workerProofError('archive-readback-unverified');
  }
  if (!collection || collection.enabled !== (collectionMode === 'enabled') || collection.error
    || (collectionMode === 'enabled' ? !Number.isSafeInteger(collection.alarmAt) || collection.alarmAt <= 0
      || collection.reason !== 'collecting' || !Number.isSafeInteger(collection.observations) || collection.observations <= 0
      : collection.alarmAt !== null)) throw workerProofError('collection-state-unverified');
  console.log('Worker deployed and canonical schedule verified. No credentials, tokens or raw responses logged.');
  console.log(`Vehicle feed: ${v}; trip-update feed: ${u}; matched corridor buses: ${profile.reportingBuses}.`);
  console.log(collectionMode === 'enabled'
    ? 'Private bus-history collection is enabled; persisted evidence, next alarm and verified private context/evidence archives were checked. Sustained quality is not yet established.'
    : 'Private bus-history collection is disabled and its alarm is cleared. Existing private evidence is retained within documented bounds.');
  // Re-allowlist even the Worker's diagnostics before printing to a public Actions log.
  for (const phase of ['authentication', 'vehicles', 'updates']) {
    const failure = profile.connectionFailures?.[phase];
    if (failure) {
      console.log(`Connection failure (${phase}): ${safeNjtFailure(new NjtError(failure.code))}.`);
    }
  }
  if (!profile.example || v !== 'ok') {
    const safeCount = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000 ? n : 0;
    console.log(`Known static trips: ${safeCount(profile.vehicleDiagnostics?.knownTrips)}; corridor route reports: ${safeCount(profile.vehicleDiagnostics?.corridorRoutes)}; missing service dates: ${safeCount(profile.vehicleDiagnostics?.missingServiceDates)}; missing GPS timestamps: ${safeCount(profile.vehicleDiagnostics?.missingObservationTimes)}.`);
    console.log('No fresh matched corridor bus confirmed yet. Collection state above is separate; real-bus and cadence acceptance remain pending.'); process.exitCode = 1;
  } else {
    // Confirm the exact same public bus through the actual tracker endpoint without printing its position.
    const [trip, date] = profile.example.tripInstanceId.split('@');
    const endpoint = new URL('/v1/live', url); endpoint.searchParams.set('trip', trip); endpoint.searchParams.set('date', date);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    const packet = response.ok ? parseLiveSnapshot(await response.json(), ds, trip, date, Date.now()) : undefined;
    if (packet?.vehicles.state !== 'ok' || !packet.observations.some((p) => p.vehicleId === profile.example.vehicleId && p.tripInstanceId === profile.example.tripInstanceId && p.observedAt >= profile.example.observedAt && Date.now() - p.observedAt <= 120_000)) throw workerProofError('exact-bus-check-failed');
    console.log('A fresh official bus report matched its canonical trip/date through the tracker endpoint. Ready for app activation and a real ride test.');
  }
}
try { await run(); } catch (error) {
  const proof = workerProofDiagnostic(error);
  if (proof) console.error(`Worker proof diagnostic: reason=${proof.reason}${proof.status === undefined ? '' : ` http=${proof.status}`}.`);
  else if ((process.env.HISTORY_COLLECTION_MODE || 'disabled') === 'disabled') console.error(`Stop diagnostic: ${safeStopFailure(error)}.`);
  if (process.env.HISTORY_COLLECTION_MODE === 'rollover-enabled') console.error(ROLLOVER_RECOVERY);
  console.error('Live Worker deployment or validation failed. Do not infer collection is inactive: verify its actual health/stop state. No raw error or secret values are logged. Check the private hosting setup.');
  process.exitCode = 1;
} finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
