import { waitForReadiness } from './collection-readiness.mjs';
// Offline-testable guards for the EXISTING manual deployment path. No mutation/retry.
import { createHash } from 'node:crypto';
import { parseDataset } from '../src/domain/dataset.ts';
import { liveApiUrl } from '../src/domain/liveBus.ts';
import { workerProofError } from './worker-content-identity.mjs';
const whole = n => Number.isSafeInteger(n) && n >= 0;
const stamp = n => whole(n) && n > 0;
const fail = () => { throw workerProofError('enabled-continuity-unverified'); };
export function preservationPins(env) {
  if (!/^[a-f0-9]{12}:[a-f0-9]{64}$/.test(env.HISTORY_CANONICAL_CONTEXT ?? '')
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(env.HISTORY_EXPECTED_WORKER_VERSION ?? '')) fail();
  return { context: env.HISTORY_CANONICAL_CONTEXT, versionId: env.HISTORY_EXPECTED_WORKER_VERSION };
}
export function requireEnabledResources(identity, pins) {
  if (identity.versionId !== pins.versionId
    || !identity.bindings.some(b => b.name === 'HISTORY_COLLECTION' && b.type === 'plain_text' && b.text === 'enabled')
    || !identity.bindings.some(b => b.name === 'FEED' && b.type === 'durable_object_namespace' && typeof b.namespace_id === 'string' && b.namespace_id)
    || !identity.bindings.some(b => b.name === 'HISTORY_ARCHIVE' && b.type === 'r2_bucket' && b.bucket_name === 'dale-history')
    || !['NJT_API_USERNAME', 'NJT_API_PASSWORD'].every(name => identity.bindings.some(b => b.name === name && b.type === 'secret_text'))) fail();
}
export function observedCanonicalIdentity(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16_000_000) fail();
  const ds = parseDataset(JSON.parse(text));
  if (ds.meta.demo || ds.meta.transcribed || ds.meta.source !== 'NJ Transit GTFS BUS G2'
    || ds.meta.realtime?.provider !== 'njt-bus-g2' || !/^[a-f0-9]{12}$/.test(ds.meta.feedVersion)
    || JSON.stringify(ds) !== text) fail();
  const sha256 = createHash('sha256').update(text).digest('hex'), context = ds.meta.feedVersion + ':' + sha256;
  return { ds, text, sha256, context };
}
export function canonicalIdentity(text, expectedContext) {
  const observed = observedCanonicalIdentity(text);
  if (observed.context !== expectedContext) fail();
  return observed;
}
export function enabledCheckpoint(collection, feedVersion, now) {
  const c = collection, a = c?.archive;
  if (!c || c.enabled !== true || c.error || c.stale || c.reason !== 'collecting' || c.scheduleVersion !== feedVersion
    || c.scheduleContextStored !== true || !stamp(c.alarmAt) || c.alarmAt <= now || c.alarmAt > now + 120_000
    || c.effectiveIntervalMs !== 30_000 || (c.cadenceTest?.expiresAt ?? 0) > now
    || !stamp(c.lastSuccessAt) || c.lastSuccessAt > now || now - c.lastSuccessAt > 120_000
    || !stamp(c.lastAttemptAt) || c.lastAttemptAt > now || !stamp(c.completedAttempt) || c.completedAttempt > c.lastAttemptAt || c.completedAttempt > c.lastSuccessAt
    || !['observations', 'batches', 'bytes', 'reservedWrites', 'databaseBytes', 'pendingInterruptionCount'].every(k => whole(c[k]))
    || !['byteLimit', 'databaseByteLimit', 'dailyWriteReservationLimit'].every(k => stamp(c[k]))
    || c.bytes >= c.byteLimit || c.databaseBytes >= c.databaseByteLimit || c.reservedWrites + 100 >= c.dailyWriteReservationLimit
    || !/^\d{4}-\d{2}-\d{2}$/.test(c.budgetDay ?? '') || c.budgetDay !== new Date(now).toISOString().slice(0, 10)
    || a?.configured !== true || a.reason !== 'ready' || a.failures !== 0 || !whole(a.verifiedObjects) || a.verifiedObjects < 2
    || !stamp(a.lastSuccessAt) || a.lastSuccessAt > now || now - a.lastSuccessAt > 120_000
    || !['reservedBytes', 'classAReserved32Days', 'classBReserved32Days', 'sqlWriteBudgetRemaining', 'backlogAgeMs'].every(k => whole(a[k]))
    || !['byteLimit', 'classALimit32Days', 'classBLimit32Days'].every(k => stamp(a[k]))
    || a.reservedBytes >= a.byteLimit || a.classAReserved32Days + 8 >= a.classALimit32Days
    || a.classBReserved32Days + 8 >= a.classBLimit32Days || a.sqlWriteBudgetRemaining < 100
    || a.backlogAgeMs > 120_000 || (a.oldestUnarchivedAt !== null && (!stamp(a.oldestUnarchivedAt) || a.oldestUnarchivedAt > now))) fail();
  // Keep only bounded aggregate proof; no raw polls, source locations or private object keys.
  return { at: now, feedVersion, alarmAt: c.alarmAt, lastSuccessAt: c.lastSuccessAt, lastAttemptAt: c.lastAttemptAt,
    completedAttempt: c.completedAttempt, observations: c.observations, batches: c.batches, bytes: c.bytes,
    reservedWrites: c.reservedWrites, budgetDay: c.budgetDay, pendingInterruptionCount: c.pendingInterruptionCount,
    byteLimit: c.byteLimit, databaseByteLimit: c.databaseByteLimit, dailyWriteReservationLimit: c.dailyWriteReservationLimit,
    effectiveIntervalMs: c.effectiveIntervalMs, archive: { verifiedObjects: a.verifiedObjects, reservedBytes: a.reservedBytes,
      lastSuccessAt: a.lastSuccessAt, byteLimit: a.byteLimit, classALimit32Days: a.classALimit32Days, classBLimit32Days: a.classBLimit32Days },
    // Aggregate size only; used by the schedule-rollover capacity gate, never by preservation rules.
    databaseBytes: c.databaseBytes };
}
export function preservesEnabled(before, after, progressSince) {
  if (before.feedVersion !== after.feedVersion) fail();
  return continuesEnabled(before, after, progressSince);
}
/** The cumulative/limit rules of preservesEnabled without its schedule-version equality.
 * A schedule rollover changes the version; these rules still hold across it. */
export function continuesEnabled(before, after, progressSince) {
  if (!['observations', 'batches', 'lastSuccessAt', 'lastAttemptAt', 'completedAttempt'].every(k => after[k] >= before[k])
    || !['byteLimit', 'databaseByteLimit', 'dailyWriteReservationLimit', 'effectiveIntervalMs'].every(k => after[k] === before[k])
    || (before.budgetDay === after.budgetDay && after.reservedWrites < before.reservedWrites)
    || !['verifiedObjects', 'reservedBytes', 'lastSuccessAt'].every(k => after.archive[k] >= before.archive[k])
    || !['byteLimit', 'classALimit32Days', 'classBLimit32Days'].every(k => after.archive[k] === before.archive[k])) fail();
  // Hot bytes may decrease through the unchanged archive-before-prune path. Cumulative
  // evidence and verified archive reservations must never reset; do not turn unknown into0.
  return progressSince === undefined || (after.completedAttempt > before.completedAttempt && after.completedAttempt > progressSince && after.lastSuccessAt > progressSince
    && after.archive.lastSuccessAt > progressSince && after.archive.verifiedObjects > before.archive.verifiedObjects);
}
async function readBounded(url, limit, net, timeoutMs = 15_000) {
  const response = await net(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, timeoutMs))), redirect: 'error', cache: 'no-store' });
  if (!response.ok || !response.body) fail();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) fail(); chunks.push(value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
/** Raw bounded /v1/collection health; callers apply every proof predicate. */
export async function readCollection(env, { net = fetch, timeoutMs = 15_000 } = {}) {
  const url = liveApiUrl(env.DALE_WORKER_URL); if (!url) fail();
  return JSON.parse(await readBounded(url + '/v1/collection', 128_000, net, timeoutMs)).collection;
}
export async function readEnabledCheckpoint(env, feedVersion, { net = fetch, clock = Date.now, timeoutMs = 15_000 } = {}) {
  const collection = await readCollection(env, { net, timeoutMs });
  return enabledCheckpoint(collection, feedVersion, clock());
}
export async function readCanonicalBytes(env, { net = fetch, expectedContext } = {}) {
  const url = liveApiUrl(env.DALE_WORKER_URL); if (!url) fail();
  const text = await readBounded(url + '/v1/schedule', 16_000_000, net);
  const canonical = expectedContext === undefined ? observedCanonicalIdentity(text) : canonicalIdentity(text, expectedContext);
  return canonical;
}
export async function readCanonicalObservation(env, { net = fetch, clock = Date.now, expectedContext } = {}) {
  const canonical = await readCanonicalBytes(env, { net, expectedContext });
  const checkpoint = await readEnabledCheckpoint(env, canonical.ds.meta.feedVersion, { net, clock });
  return { ...canonical, checkpoint };
}
export async function readPreservedCanonical(env, options = {}) {
  const pins = preservationPins(env);
  return readCanonicalObservation(env, { ...options, expectedContext: pins.context });
}

// Both update paths explicitly request this same reviewed/provider-supported bound.
export const CODE_DEFERRAL_MS = 300_000, TRANSITION_PROOF_MS = 420_000;
/** Old-actor progress or a late receipt for a pre-boundary attempt is not adoption. */
export async function waitForTransitionProgress(before, read, acknowledgedAt, { clock = Date.now, sleep } = {}) {
  if (!stamp(acknowledgedAt) || acknowledgedAt > clock()) fail();
  const boundaryAt = acknowledgedAt + CODE_DEFERRAL_MS, deadline = acknowledgedAt + TRANSITION_PROOF_MS;
  const remaining = deadline - clock(); if (remaining <= 0) fail();
  const checkpoint = await waitForReadiness(async timeoutMs => {
    const at = clock();
    if (at <= boundaryAt) return undefined; // Do not poll the actor during deferral.
    const left = deadline - at; if (left <= 0) return undefined;
    const current = await read(Math.min(timeoutMs, left));
    if (clock() >= deadline) return undefined;
    return preservesEnabled(before, current, boundaryAt) ? current : undefined;
  }, { clock, ...(sleep ? { sleep } : {}), timeoutMs: remaining, intervalMs: 5000 });
  if (!checkpoint || !preservesEnabled(before, checkpoint, boundaryAt)) fail();
  return { checkpoint, acknowledgedAt, boundaryAt };
}

// Schedule rollover (D68): the reviewed update deliberately changes the schedule version.
// The new actor stores the new context before its first batch, so it reports 'starting'
// (and the old actor keeps reporting the old version) for a while: those reads wait.
export const ROLLOVER_PROOF_MS = 600_000, SERVED_SCHEDULE_WAIT_MS = 60_000;
/** Classifies one raw /v1/collection read. Returns the qualifying checkpoint, undefined
 * to keep waiting, or throws on a definite failure (context refused, evidence regressed). */
export function rolloverProgress(before, collection, feedVersion, boundaryAt, now) {
  const c = collection;
  if (!c || typeof c !== 'object') return undefined;
  // The new actor exists, but its constructor could not store the new context
  // (capacity or write budget). It does not retry until rebuilt: fail fast.
  if (c.error === true && c.scheduleVersion === feedVersion && c.scheduleContextStored === false) throw workerProofError('rollover-context-admission-failed');
  if (c.scheduleVersion !== feedVersion || c.reason === 'starting' || c.scheduleContextStored !== true) return undefined;
  let checkpoint;
  try { checkpoint = enabledCheckpoint(c, feedVersion, now); } catch { return undefined; }
  // Cumulative evidence or limits that regress never recover: continuesEnabled throws.
  return continuesEnabled(before, checkpoint, boundaryAt) ? checkpoint : undefined;
}
/** Like waitForTransitionProgress, across a schedule change: no actor reads during the
 * deferral, a longer deadline, and transient states (and unreadable reads) keep waiting. */
export async function waitForRolloverProgress(before, readRaw, feedVersion, acknowledgedAt, { clock = Date.now, sleep } = {}) {
  if (!stamp(acknowledgedAt) || acknowledgedAt > clock() || !/^[a-f0-9]{12}$/.test(feedVersion ?? '') || feedVersion === before.feedVersion) fail();
  const boundaryAt = acknowledgedAt + CODE_DEFERRAL_MS, deadline = acknowledgedAt + ROLLOVER_PROOF_MS;
  const remaining = deadline - clock(); if (remaining <= 0) throw workerProofError('rollover-progress-unverified');
  const checkpoint = await waitForReadiness(async timeoutMs => {
    const at = clock();
    if (at <= boundaryAt) return undefined; // Do not poll the actor during deferral.
    const left = deadline - at; if (left <= 0) return undefined;
    let raw;
    try { raw = await readRaw(Math.min(timeoutMs, left)); } catch { return undefined; }
    const now = clock(); if (now >= deadline) return undefined;
    return rolloverProgress(before, raw, feedVersion, boundaryAt, now);
  }, { clock, ...(sleep ? { sleep } : {}), timeoutMs: remaining, intervalMs: 5000 });
  if (!checkpoint) throw workerProofError('rollover-progress-unverified');
  return { checkpoint, acknowledgedAt, boundaryAt };
}
/** After upload the stateless router serves the new bytes; allow brief propagation, during
 * which only the exact previous context may still be served. */
export async function waitForServedContext(env, expectedContext, previousContext, { net = fetch, clock = Date.now, sleep } = {}) {
  const served = await waitForReadiness(async () => {
    const observed = await readCanonicalBytes(env, { net });
    if (observed.context === expectedContext) return observed;
    if (observed.context === previousContext) return undefined;
    throw workerProofError('rollover-schedule-not-served');
  }, { clock, ...(sleep ? { sleep } : {}), timeoutMs: SERVED_SCHEDULE_WAIT_MS, intervalMs: 5000 });
  if (!served) throw workerProofError('rollover-schedule-not-served');
  return served;
}
