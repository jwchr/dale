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
export function canonicalIdentity(text, expectedContext) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16_000_000) fail();
  const ds = parseDataset(JSON.parse(text));
  if (ds.meta.demo || ds.meta.transcribed || ds.meta.source !== 'NJ Transit GTFS BUS G2'
    || ds.meta.realtime?.provider !== 'njt-bus-g2' || !/^[a-f0-9]{12}$/.test(ds.meta.feedVersion)
    || JSON.stringify(ds) !== text) fail();
  const sha256 = createHash('sha256').update(text).digest('hex'), context = ds.meta.feedVersion + ':' + sha256;
  if (context !== expectedContext) fail();
  return { ds, text, sha256, context };
}
export function enabledCheckpoint(collection, feedVersion, now) {
  const c = collection, a = c?.archive;
  if (!c || c.enabled !== true || c.error || c.stale || c.reason !== 'collecting' || c.scheduleVersion !== feedVersion
    || c.scheduleContextStored !== true || !stamp(c.alarmAt) || c.alarmAt <= now || c.alarmAt > now + 120_000
    || c.effectiveIntervalMs !== 30_000 || (c.cadenceTest?.expiresAt ?? 0) > now
    || !stamp(c.lastSuccessAt) || c.lastSuccessAt > now || now - c.lastSuccessAt > 120_000
    || !stamp(c.lastAttemptAt) || !stamp(c.completedAttempt) || c.completedAttempt > c.lastAttemptAt
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
      lastSuccessAt: a.lastSuccessAt, byteLimit: a.byteLimit, classALimit32Days: a.classALimit32Days, classBLimit32Days: a.classBLimit32Days } };
}
export function preservesEnabled(before, after, progressSince) {
  if (before.feedVersion !== after.feedVersion
    || !['observations', 'batches', 'lastSuccessAt', 'lastAttemptAt', 'completedAttempt'].every(k => after[k] >= before[k])
    || !['byteLimit', 'databaseByteLimit', 'dailyWriteReservationLimit', 'effectiveIntervalMs'].every(k => after[k] === before[k])
    || (before.budgetDay === after.budgetDay && after.reservedWrites < before.reservedWrites)
    || !['verifiedObjects', 'reservedBytes', 'lastSuccessAt'].every(k => after.archive[k] >= before.archive[k])
    || !['byteLimit', 'classALimit32Days', 'classBLimit32Days'].every(k => after.archive[k] === before.archive[k])) fail();
  // Hot bytes may decrease through the unchanged archive-before-prune path. Cumulative
  // evidence and verified archive reservations must never reset; do not turn unknown into0.
  return progressSince === undefined || (after.completedAttempt > before.completedAttempt && after.lastSuccessAt > progressSince
    && after.archive.lastSuccessAt > progressSince && after.archive.verifiedObjects > before.archive.verifiedObjects);
}
async function readBounded(url, limit, net) {
  const response = await net(url, { signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
  if (!response.ok || !response.body) fail();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) fail(); chunks.push(value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
export async function readEnabledCheckpoint(env, feedVersion, { net = fetch, clock = Date.now } = {}) {
  const url = liveApiUrl(env.DALE_WORKER_URL); if (!url) fail();
  const raw = JSON.parse(await readBounded(url + '/v1/collection', 128_000, net));
  return enabledCheckpoint(raw.collection, feedVersion, clock());
}
export async function readPreservedCanonical(env, { net = fetch, clock = Date.now } = {}) {
  const pins = preservationPins(env), url = liveApiUrl(env.DALE_WORKER_URL); if (!url) fail();
  const canonical = canonicalIdentity(await readBounded(url + '/v1/schedule', 16_000_000, net), pins.context);
  const checkpoint = await readEnabledCheckpoint(env, canonical.ds.meta.feedVersion, { net, clock });
  return { ...canonical, checkpoint };
}
