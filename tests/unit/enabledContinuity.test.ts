import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { liveDataset, NOW } from '../helpers/liveBus';
import { historyContextKey } from '../../worker/history-journal';
import { A_LIMIT, B_LIMIT, CORRIDOR_RESERVE } from '../../worker/history-archive';
// @ts-expect-error native deployment helper
import { canonicalIdentity, CORRIDOR_RESERVE as SCRIPT_RESERVE, APPROVED_ARCHIVE_CLASS_A_LIMIT, APPROVED_ARCHIVE_CLASS_B_LIMIT, APPROVED_RAW_LIMITS, enabledCheckpoint, preservesEnabled, preservationPins, readPreservedCanonical, readEnabledCheckpoint, ALARM_REREAD_ATTEMPTS, ALARM_REREAD_MS, waitForTransitionProgress, CODE_DEFERRAL_MS, TRANSITION_PROOF_MS } from '../../scripts/enabled-continuity.mjs';
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
  it.each(['disabled', 'alarm', 'context', 'rate', 'archive', 'quota', 'backlog', 'cadence', 'unknown-counters', 'future-native'])('rejects %s before upload', kind => {
    const c = collection();
    if (kind === 'future-native') c.lastAttemptAt = c.completedAttempt = NOW + 1;
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
    // Retained batches fall when verified rows are pruned: not a reset. Observations are cumulative.
    expect(preservesEnabled(before, { ...after, batches: 0 }, NOW)).toBe(true);
    expect(() => preservesEnabled(before, { ...after, observations: before.observations - 1 })).toThrow();
    expect(() => preservesEnabled(before, { ...after, dailyWriteReservationLimit: 999999 })).toThrow();
    // D84: the daily write counter may rise from 75,000 to the approved 90,000 once, never elsewhere and never down.
    expect(preservesEnabled({ ...before, dailyWriteReservationLimit: 75_000 }, { ...after, dailyWriteReservationLimit: 90_000 }, NOW)).toBe(true);
    expect(() => preservesEnabled({ ...before, dailyWriteReservationLimit: 75_000 }, { ...after, dailyWriteReservationLimit: 89_999 })).toThrow();
    expect(() => preservesEnabled({ ...before, dailyWriteReservationLimit: 90_000 }, { ...after, dailyWriteReservationLimit: 75_000 })).toThrow();
    expect(() => preservesEnabled(before, { ...after, archive: { ...after.archive, reservedBytes: 0 } })).toThrow();
    // D86: the archive ceiling may rise to the approved 500 GB guard, never above it and never down.
    expect(preservesEnabled(before, { ...after, archive: { ...after.archive, byteLimit: 500_000_000_000 } }, NOW)).toBe(true);
    expect(() => preservesEnabled(before, { ...after, archive: { ...after.archive, byteLimit: 500_000_000_001 } })).toThrow();
    expect(() => preservesEnabled(before, { ...after, archive: { ...after.archive, byteLimit: 8_999_999_999 } })).toThrow();
    expect(() => preservesEnabled(before, { ...after, archive: { ...after.archive, classALimit32Days: 800_001 } })).toThrow();
    expect(() => preservesEnabled(before, { ...after, archive: { ...after.archive, byteLimit: 20_000_000_000 } })).toThrow();
    // D78: raw limits arrive with the corridor reserve, then never change.
    const big = { ...after.archive, byteLimit: 500_000_000_000 };
    const raw78 = { ...big, rawByteLimit: 498_000_000_000, rawClassALimit32Days: 650_000, rawClassBLimit32Days: 7_850_000 };
    expect(preservesEnabled(before, { ...after, archive: raw78 }, NOW)).toBe(true);
    expect(() => preservesEnabled(before, { ...after, archive: { ...raw78, rawByteLimit: 500_000_000_000 } })).toThrow();
    expect(() => preservesEnabled(before, { ...after, archive: { ...raw78, rawClassALimit32Days: 650_001 } })).toThrow();
    const live = { ...before, archive: { ...before.archive, byteLimit: 500_000_000_000, rawByteLimit: 498_000_000_000, rawClassALimit32Days: 650_000, rawClassBLimit32Days: 7_850_000 } };
    expect(preservesEnabled(live, { ...after, archive: raw78 }, NOW)).toBe(true);
    expect(() => preservesEnabled(live, { ...after, archive: { ...raw78, rawClassBLimit32Days: 7_000_000 } })).toThrow();
    expect(() => preservesEnabled(live, { ...after, archive: big })).toThrow();
    // A rollback keeps the 500 GB guard: lowering it is refused (turn RAW_ARCHIVE off instead).
    expect(() => preservesEnabled(live, { ...after, archive: { ...raw78, byteLimit: 9_000_000_000 } })).toThrow();
  });
  it('lets the Class A guard rise only to the approved 3,000,000 and raw limits move only to the approved set (D86)', () => {
    const c = collection(); c.archive.classALimit32Days = 500_000;
    const before = enabledCheckpoint(c, ds.meta.feedVersion, NOW);
    const raw = collection(); raw.bytes = 500; raw.completedAttempt = NOW + 20000; raw.lastAttemptAt = NOW + 20000; raw.lastSuccessAt = NOW + 20000;
    raw.observations++; raw.batches++; raw.reservedWrites += 12; raw.alarmAt = NOW + 50000;
    raw.archive.verifiedObjects++; raw.archive.reservedBytes += 500; raw.archive.lastSuccessAt = NOW + 21000;
    Object.assign(raw.archive, { byteLimit: 500_000_000_000, classALimit32Days: 3_000_000, classBLimit32Days: 9_000_000, ...APPROVED_RAW_LIMITS });
    const after = enabledCheckpoint(raw, ds.meta.feedVersion, NOW + 22000);
    expect(preservesEnabled(before, after, NOW)).toBe(true);
    expect(() => preservesEnabled(before, { ...after, archive: { ...after.archive, classALimit32Days: 3_100_000 } })).toThrow();
    expect(() => preservesEnabled(before, { ...after, archive: { ...after.archive, classALimit32Days: 2_900_000 } })).toThrow();
    // Once at 3,000,000 it never falls back.
    const live = { ...before, archive: { ...before.archive, byteLimit: 500_000_000_000, classALimit32Days: 3_000_000, rawByteLimit: 498_000_000_000, rawClassALimit32Days: 350_000, rawClassBLimit32Days: 7_850_000 } };
    expect(preservesEnabled(live, after, NOW)).toBe(true);
    expect(() => preservesEnabled(live, { ...after, archive: { ...after.archive, classALimit32Days: 500_000, rawClassALimit32Days: 350_000 } })).toThrow();
    expect(() => preservesEnabled(live, { ...after, archive: { ...after.archive, rawClassALimit32Days: 2_000_000 } })).toThrow();
    // A guard already above the approved value (a later owner decision) never falls back to it (Neon, #278).
    const higher = { ...live, archive: { ...live.archive, byteLimit: 600_000_000_000, classALimit32Days: 3_500_000 } };
    expect(() => preservesEnabled(higher, after, NOW)).toThrow();
    expect(() => preservesEnabled(higher, { ...after, archive: { ...after.archive, classALimit32Days: 3_500_000 } }, NOW)).toThrow();
    // Raw limits already above the approved set never fall back to it either (Neon Nov24 c, #278).
    const rawHigher = { ...live, archive: { ...live.archive, rawClassALimit32Days: 2_900_000, rawClassBLimit32Days: 8_900_000 } };
    expect(() => preservesEnabled(rawHigher, after, NOW)).toThrow();
    // The approved values match what the Worker reports (D86, paid R2, fixed ceilings).
    expect(APPROVED_ARCHIVE_CLASS_A_LIMIT).toBe(A_LIMIT);
    expect(APPROVED_ARCHIVE_CLASS_B_LIMIT).toBe(B_LIMIT);
    expect(APPROVED_RAW_LIMITS.rawClassALimit32Days).toBe(A_LIMIT - CORRIDOR_RESERVE.a);
    expect(APPROVED_RAW_LIMITS.rawClassBLimit32Days).toBe(B_LIMIT - CORRIDOR_RESERVE.b);
    // Class B stays inside R2's free 10,000,000 a month; Class A stays a fixed ceiling, never unlimited.
    expect(B_LIMIT).toBeLessThan(10_000_000);
    expect(A_LIMIT).toBeLessThanOrEqual(3_000_000);
  });
  it('lets the Class B guard rise only to the approved 9,000,000 (D86)', () => {
    const before = enabledCheckpoint(collection(), ds.meta.feedVersion, NOW);
    const raw = collection(); raw.bytes = 500; raw.completedAttempt = NOW + 20000; raw.lastAttemptAt = NOW + 20000; raw.lastSuccessAt = NOW + 20000;
    raw.observations++; raw.batches++; raw.reservedWrites += 12; raw.alarmAt = NOW + 50000;
    raw.archive.verifiedObjects++; raw.archive.reservedBytes += 500; raw.archive.lastSuccessAt = NOW + 21000;
    const after = enabledCheckpoint(raw, ds.meta.feedVersion, NOW + 22000);
    expect(preservesEnabled(before, { ...after, archive: { ...after.archive, classBLimit32Days: 9_000_000 } }, NOW)).toBe(true);
    expect(() => preservesEnabled(before, { ...after, archive: { ...after.archive, classBLimit32Days: 9_000_001 } })).toThrow();
    expect(() => preservesEnabled(before, { ...after, archive: { ...after.archive, classBLimit32Days: 7_999_999 } })).toThrow();
  });
  it('keeps the deploy proof corridor reserve equal to the Worker reserve', () => {
    expect(SCRIPT_RESERVE).toEqual(CORRIDOR_RESERVE);
  });
  it('projects raw limits from live health only when present', () => {
    const c = collection(); Object.assign(c.archive, { rawByteLimit: 37_000_000_000, rawClassALimit32Days: 650_000, rawClassBLimit32Days: 7_850_000 });
    expect(enabledCheckpoint(c, ds.meta.feedVersion, NOW).archive).toMatchObject({ rawByteLimit: 37_000_000_000, rawClassALimit32Days: 650_000 });
    expect(enabledCheckpoint(collection(), ds.meta.feedVersion, NOW).archive.rawByteLimit).toBeUndefined();
    const bad = collection(); Object.assign(bad.archive, { rawByteLimit: 37_000_000_000 });
    expect(() => enabledCheckpoint(bad, ds.meta.feedVersion, NOW)).toThrow();
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
  it('re-reads while a poll is running (alarm cleared), but never waits out any other unhealthy field', async () => {
    const replies = (list: object[]) => { let n = 0; const net = (async () => Response.json({ collection: list[Math.min(n++, list.length - 1)] })) as unknown as typeof fetch;
      return { net, calls: () => n }; };
    const sleeps: number[] = [], sleep = async (ms: number) => { sleeps.push(ms); };
    const running = { ...collection(), alarmAt: null }, past = { ...collection(), alarmAt: NOW - 1 };
    const recovers = replies([running, past, collection()]);
    await expect(readEnabledCheckpoint(env, ds.meta.feedVersion, { net: recovers.net, clock: () => NOW, sleep })).resolves.toMatchObject({ alarmAt: NOW + 30000 });
    expect(recovers.calls()).toBe(3); expect(sleeps).toEqual([ALARM_REREAD_MS, ALARM_REREAD_MS]);
    const stuck = replies([running]);
    await expect(readEnabledCheckpoint(env, ds.meta.feedVersion, { net: stuck.net, clock: () => NOW, sleep })).rejects.toThrow();
    expect(stuck.calls()).toBe(ALARM_REREAD_ATTEMPTS);
    const stale = replies([{ ...collection(), stale: true }, collection()]);
    await expect(readEnabledCheckpoint(env, ds.meta.feedVersion, { net: stale.net, clock: () => NOW, sleep })).rejects.toThrow();
    expect(stale.calls()).toBe(1);
    const off = replies([{ ...collection(), enabled: false, alarmAt: null }, collection()]);
    await expect(readEnabledCheckpoint(env, ds.meta.feedVersion, { net: off.net, clock: () => NOW, sleep })).rejects.toThrow();
    expect(off.calls()).toBe(1);
  });
});

describe('post-acknowledgement transition readiness', () => {
  it('does not read before the full boundary, then requires native ATTEMPT START and archive source clocks after it', async () => {
    const before = enabledCheckpoint(collection(), ds.meta.feedVersion, NOW), acknowledgedAt = NOW + 45000;
    let clock = acknowledgedAt; const readTimes: number[] = [];
    const result = await waitForTransitionProgress(before, async (timeoutMs: number) => {
      readTimes.push(clock); expect(clock).toBeGreaterThan(acknowledgedAt + CODE_DEFERRAL_MS);
      expect(timeoutMs).toBeLessThanOrEqual(acknowledgedAt + TRANSITION_PROOF_MS - clock);
      const raw = collection(); raw.alarmAt = clock + 30000; raw.lastSuccessAt = clock - 500; raw.archive.lastSuccessAt = clock - 100;
      raw.lastAttemptAt = raw.completedAttempt = clock < acknowledgedAt + CODE_DEFERRAL_MS + 30000 ? acknowledgedAt + CODE_DEFERRAL_MS - 1 : clock - 1000;
      raw.archive.verifiedObjects++; raw.observations++; raw.batches++; raw.archive.reservedBytes++;
      return enabledCheckpoint(raw, ds.meta.feedVersion, clock);
    }, acknowledgedAt, { clock: () => clock, sleep: async (ms: number) => { clock += ms; } });
    expect(result.boundaryAt).toBe(acknowledgedAt + 300000);
    expect(result.checkpoint.completedAttempt).toBeGreaterThan(result.boundaryAt);
    expect(result.checkpoint.archive.lastSuccessAt).toBeGreaterThan(result.boundaryAt);
    expect(readTimes.length).toBeGreaterThan(1); // fresh receipts for an old attempt did NOT qualify
  });
  it('caps reads by the absolute remaining deadline and refuses a valid result that arrives at expiry', async () => {
    const before = enabledCheckpoint(collection(), ds.meta.feedVersion, NOW); let clock = NOW; let finalTimeout: number | undefined;
    await expect(waitForTransitionProgress(before, async (timeoutMs: number) => {
      if (clock < NOW + TRANSITION_PROOF_MS - 5000) return before;
      finalTimeout = timeoutMs; clock = NOW + TRANSITION_PROOF_MS;
      const raw = collection(); raw.alarmAt = clock + 30000; raw.completedAttempt = raw.lastAttemptAt = clock - 1000;
      raw.lastSuccessAt = clock - 500; raw.archive.lastSuccessAt = clock - 100; raw.archive.verifiedObjects++;
      return enabledCheckpoint(raw, ds.meta.feedVersion, clock);
    }, NOW, { clock: () => clock, sleep: async (ms: number) => { clock += ms; } })).rejects.toThrow();
    expect(finalTimeout).toBe(5000);
  });
  it('bounds a stalled clock without actor reads or success', async () => {
    const before = enabledCheckpoint(collection(), ds.meta.feedVersion, NOW); let reads = 0;
    await expect(waitForTransitionProgress(before, async () => { reads++; return before; }, NOW, { clock: () => NOW, sleep: async () => {} })).rejects.toThrow();
    expect(reads).toBe(0);
  });
});
