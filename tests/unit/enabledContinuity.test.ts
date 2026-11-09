import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { liveDataset, NOW } from '../helpers/liveBus';
import { historyContextKey } from '../../worker/history-journal';
// @ts-expect-error native deployment helper
import { canonicalIdentity, enabledCheckpoint, preservesEnabled, preservationPins, readPreservedCanonical } from '../../scripts/enabled-continuity.mjs';
const ds = structuredClone(liveDataset); ds.meta.feedVersion = 'abcdef123456'; ds.meta.source = 'NJ Transit GTFS BUS G2';
const text = JSON.stringify(ds), context = ds.meta.feedVersion + ':' + createHash('sha256').update(text).digest('hex');
const env = { HISTORY_CANONICAL_CONTEXT: context, HISTORY_EXPECTED_WORKER_VERSION: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', DALE_WORKER_URL: 'https://dale-live.synthetic.workers.dev' };
function collection() { return { enabled: true, error: false, stale: false, reason: 'collecting', scheduleVersion: ds.meta.feedVersion, scheduleContextStored: true,
  alarmAt: NOW + 30000, effectiveIntervalMs: 30000, lastSuccessAt: NOW - 1000, lastAttemptAt: NOW - 1000, completedAttempt: NOW - 1000,
  observations: 100, batches: 20, bytes: 1000, reservedWrites: 100, databaseBytes: 2000, pendingInterruptionCount: 0,
  byteLimit: 250000000, databaseByteLimit: 500000000, dailyWriteReservationLimit: 75000, budgetDay: '2026-11-04',
  archive: { configured: true, reason: 'ready', failures: 0, verifiedObjects: 21, lastSuccessAt: NOW - 500,
    reservedBytes: 5000, classAReserved32Days: 30, classBReserved32Days: 30, sqlWriteBudgetRemaining: 74000,
    oldestUnarchivedAt: null, backlogAgeMs: 0, byteLimit: 9000000000, classALimit32Days: 800000, classBLimit32Days: 8000000 } }; }
describe('enabled collector preservation without migration or mutation', () => {
  it('pins exact canonical bytes and the actual journal context, preserving builtAt and city fields', async () => {
    expect(preservationPins(env)).toEqual({ context, versionId: env.HISTORY_EXPECTED_WORKER_VERSION });
    expect(canonicalIdentity(text, context).text).toBe(text);
    expect((await historyContextKey(ds))).toBe(context);
    for (const changed of [text + '\n', JSON.stringify({ ...ds, meta: { ...ds.meta, builtAt: '2026-11-09T00:00:00Z' } }), JSON.stringify({ ...ds, stops: ds.stops.map(s => ({ ...s, city: 'Changed' })) })])
      expect(() => canonicalIdentity(changed, context)).toThrow();
    expect(() => preservationPins({ ...env, HISTORY_EXPECTED_WORKER_VERSION: '' })).toThrow();
  });
  it.each(['disabled', 'alarm', 'context', 'rate', 'archive', 'quota', 'backlog', 'cadence', 'unknown-counters'])('rejects %s before upload', kind => {
    const c = collection();
    if (kind === 'disabled') c.enabled = false;
    if (kind === 'alarm') c.alarmAt = NOW - 1;
    if (kind === 'context') c.scheduleVersion = 'other';
    if (kind === 'rate') c.effectiveIntervalMs = 5000;
    if (kind === 'archive') c.archive.configured = false;
    if (kind === 'quota') c.reservedWrites = 74999;
    if (kind === 'backlog') c.archive.backlogAgeMs = 180000;
    if (kind === 'cadence') Object.assign(c, { cadenceTest: { expiresAt: NOW + 1 } });
    if (kind === 'unknown-counters') delete (c as Partial<typeof c>).pendingInterruptionCount;
    expect(() => enabledCheckpoint(c, ds.meta.feedVersion, NOW)).toThrow();
  });
  it('requires native progress, never resets cumulative evidence, permits verified archive-before-prune bytes', () => {
    const before = enabledCheckpoint(collection(), ds.meta.feedVersion, NOW);
    expect(preservesEnabled(before, before, NOW)).toBe(false);
    const raw = collection(); raw.bytes = 500; raw.completedAttempt = NOW + 20000; raw.lastAttemptAt = NOW + 20000; raw.lastSuccessAt = NOW + 20000;
    raw.observations++; raw.batches++; raw.reservedWrites += 12; raw.alarmAt = NOW + 50000;
    raw.archive.verifiedObjects++; raw.archive.reservedBytes += 500; raw.archive.lastSuccessAt = NOW + 21000;
    const after = enabledCheckpoint(raw, ds.meta.feedVersion, NOW + 22000);
    expect(preservesEnabled(before, after, NOW)).toBe(true);
    expect(() => preservesEnabled(before, { ...after, batches: 0 })).toThrow();
    expect(() => preservesEnabled(before, { ...after, dailyWriteReservationLimit: 999999 })).toThrow();
    expect(() => preservesEnabled(before, { ...after, archive: { ...after.archive, reservedBytes: 0 } })).toThrow();
  });
  it('reads only bounded static schedule and collection health, never auth/live/status or a mutation', async () => {
    const calls: string[] = [];
    const net = async (url: string, options: RequestInit) => { calls.push(url); expect(options.redirect).toBe('error'); expect(options.method).toBeUndefined();
      if (url.endsWith('/v1/schedule')) return new Response(text);
      if (url.endsWith('/v1/collection')) return Response.json({ collection: collection() });
      throw new Error('Unexpected network'); };
    const receipt = await readPreservedCanonical(env, { net, clock: () => NOW });
    expect(receipt.context).toBe(context); expect(receipt.text).toBe(text); expect(calls).toHaveLength(2);
  });
});
