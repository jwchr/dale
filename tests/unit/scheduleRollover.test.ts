import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryJournal, historyContextKey, type HistoryStorage } from '../../worker/history-journal';
import { liveDataset, NOW } from '../helpers/liveBus';
// @ts-expect-error native deployment helper
import { contextPartCount, requireCoverage, rolloverCapacity, CONTEXT_MAX_BYTES, CONTEXT_PART_CHARS, ROLLOVER_WRITE_HEADROOM } from '../../scripts/schedule-rollover.mjs';
// @ts-expect-error native deployment helper
import { enabledCheckpoint, preservesEnabled, rolloverProgress, waitForRolloverProgress, CODE_DEFERRAL_MS, ROLLOVER_PROOF_MS } from '../../scripts/enabled-continuity.mjs';
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function storage(): { db: DatabaseSync; storage: HistoryStorage } {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  return { db, storage: {
    sql: { get databaseSize() { return 0; }, exec(query, ...bindings) { const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[]; return { toArray: () => rows }; } },
    transactionSync<T>(callback: () => T): T { db.exec('BEGIN'); try { const v = callback(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  } };
}
const OLD = 'abcdef123456', NEW = 'fedcba654321';
function collection(feed = OLD, at = NOW) { return { enabled: true, error: false, stale: false, reason: 'collecting', scheduleVersion: feed, scheduleContextStored: true,
  alarmAt: at + 30000, effectiveIntervalMs: 30000, lastSuccessAt: at - 500, lastAttemptAt: at - 1000, completedAttempt: at - 1000,
  observations: 100, batches: 20, bytes: 1000, reservedWrites: 100, databaseBytes: 2000, pendingInterruptionCount: 0,
  byteLimit: 250000000, databaseByteLimit: 500000000, dailyWriteReservationLimit: 75000, budgetDay: '2026-11-04',
  archive: { configured: true, reason: 'ready', failures: 0, verifiedObjects: 21, lastSuccessAt: at - 100,
    reservedBytes: 5000, classAReserved32Days: 30, classBReserved32Days: 30, sqlWriteBudgetRemaining: 74000,
    oldestUnarchivedAt: null, backlogAgeMs: 0, byteLimit: 9000000000, classALimit32Days: 800000, classBLimit32Days: 8000000 } }; }

describe('rollover capacity mirrors the Worker context admission', () => {
  it('splits the context into exactly as many SQL parts as ensureContext, including a surrogate pair at a boundary', async () => {
    const big = structuredClone(liveDataset);
    const probe = JSON.stringify({ ...big, stops: big.stops.map((s, i) => i ? s : { ...s, name: '\u{1F68C}' }) }).indexOf('\u{1F68C}');
    big.stops[0]!.name = 'x'.repeat(CONTEXT_PART_CHARS - 1 - probe) + '\u{1F68C}' + 'y'.repeat(70_000);
    const body = JSON.stringify(big); expect(body.charCodeAt(CONTEXT_PART_CHARS - 1)).toBeGreaterThanOrEqual(0xD800);
    const { db, storage: s } = storage(), key = await historyContextKey(big);
    new HistoryJournal(s, big, key).setEnabled(true, NOW);
    const parts = db.prepare('SELECT part,length(body) AS n FROM dale_history_schedules WHERE feed_version=? AND part>=0 ORDER BY part').all(key);
    expect(parts.length).toBe(contextPartCount(body)); expect(parts[0]!.n).toBe(CONTEXT_PART_CHARS - 1);
    const state = JSON.parse(String(db.prepare('SELECT body FROM dale_history_meta').get()!.body));
    expect(state.reservedWrites).toBe(2 * contextPartCount(body) + 4); expect(state.bytes).toBe(Buffer.byteLength(body));
  });
  it('keeps the mirrored limits equal to the Worker source', () => {
    const source = readFileSync(new URL('../../worker/history-journal.ts', import.meta.url), 'utf8');
    expect(CONTEXT_MAX_BYTES).toBe(16_000_000); expect(source).toContain(`bytes > ${CONTEXT_MAX_BYTES.toLocaleString('en-US').replaceAll(',', '_')}`);
    expect(source).toContain(`start + ${CONTEXT_PART_CHARS.toLocaleString('en-US').replace(',', '_')}`);
    expect(source).toContain('const reservation = 2 * parts.length + 4;');
  });
  it('refuses on context bytes, journal bytes, database bytes and the daily write budget with headroom', () => {
    const c = enabledCheckpoint(collection(), OLD, NOW), text = JSON.stringify(liveDataset), bytes = Buffer.byteLength(text), units = 2 * contextPartCount(text) + 4;
    expect(rolloverCapacity(c, text).ok).toBe(true);
    expect(rolloverCapacity({ ...c, bytes: c.byteLimit - bytes }, text).ok).toBe(true);
    expect(rolloverCapacity({ ...c, bytes: c.byteLimit - bytes + 1 }, text).ok).toBe(false);
    expect(rolloverCapacity({ ...c, databaseBytes: c.databaseByteLimit - bytes }, text).ok).toBe(false);
    expect(rolloverCapacity({ ...c, reservedWrites: c.dailyWriteReservationLimit - units - ROLLOVER_WRITE_HEADROOM }, text).ok).toBe(true);
    expect(rolloverCapacity({ ...c, reservedWrites: c.dailyWriteReservationLimit - units - ROLLOVER_WRITE_HEADROOM + 1 }, text).ok).toBe(false);
    expect(rolloverCapacity(c, 'x'.repeat(CONTEXT_MAX_BYTES + 1)).ok).toBe(false);
    expect(() => rolloverCapacity({ ...c, reservedWrites: undefined }, text)).toThrow();
    expect(Object.values(rolloverCapacity(c, text).summary).every(v => v === null || Number.isSafeInteger(v))).toBe(true);
  });
  it('requires corridor trips on every service date of the coming week', () => {
    // The fixture runs weekdays only, so a full week fails; an all-days copy passes.
    expect(() => requireCoverage(liveDataset, '20261104')).toThrow('rollover-coverage-gap');
    const daily = structuredClone(liveDataset); for (const cal of Object.values(daily.calendars)) cal.days = [true, true, true, true, true, true, true];
    expect(requireCoverage(daily, '20261104')).toMatchObject({ from: '20261104', to: '20261111' });
    expect(() => requireCoverage(daily, '20261104', 7 + 200)).toThrow('rollover-coverage-gap');
  });
});

describe('rollover transition proof', () => {
  const before = enabledCheckpoint(collection(), OLD, NOW), boundary = NOW + 1;
  it('waits on transient states, fails fast on a refused context and on regressed evidence', () => {
    const at = NOW + 60_000, valid = { ...collection(NEW, at), observations: 101, batches: 21, archive: { ...collection(NEW, at).archive, verifiedObjects: 22 } };
    expect(rolloverProgress(before, collection(OLD, at), NEW, boundary, at)).toBeUndefined();
    expect(rolloverProgress(before, { ...valid, reason: 'starting' }, NEW, boundary, at)).toBeUndefined();
    expect(rolloverProgress(before, { ...valid, scheduleContextStored: false }, NEW, boundary, at)).toBeUndefined();
    expect(rolloverProgress(before, { ...valid, error: true }, NEW, boundary, at)).toBeUndefined();
    expect(rolloverProgress(before, undefined, NEW, boundary, at)).toBeUndefined();
    expect(() => rolloverProgress(before, { ...valid, error: true, scheduleContextStored: false }, NEW, boundary, at)).toThrow('rollover-context-admission-failed');
    expect(() => rolloverProgress(before, { ...valid, observations: 99 }, NEW, boundary, at)).toThrow('enabled-continuity-unverified');
    expect(() => rolloverProgress(before, { ...valid, dailyWriteReservationLimit: 1e6 }, NEW, boundary, at)).toThrow();
    expect(rolloverProgress(before, valid, NEW, boundary, at)).toMatchObject({ feedVersion: NEW, observations: 101 });
    // No progress after the boundary yet: keep waiting.
    expect(rolloverProgress(before, valid, NEW, at, at)).toBeUndefined();
    // Preservation keeps refusing a changed version, unchanged.
    expect(() => preservesEnabled(before, enabledCheckpoint(valid, NEW, at))).toThrow();
  });
  it('never reads during the deferral, tolerates unreadable reads and times out with a fixed reason', async () => {
    let clock = NOW; const reads: number[] = [];
    await expect(waitForRolloverProgress(before, async () => { reads.push(clock); throw new Error('PRIVATE network detail'); }, NEW, NOW,
      { clock: () => clock, sleep: async (ms: number) => { clock += ms; } })).rejects.toThrow('rollover-progress-unverified');
    expect(reads.length).toBeGreaterThan(0); expect(reads.every(at => at > NOW + CODE_DEFERRAL_MS)).toBe(true);
    expect(clock).toBeGreaterThanOrEqual(NOW + ROLLOVER_PROOF_MS - 5000);
    await expect(waitForRolloverProgress(before, async () => collection(), OLD, NOW, { clock: () => NOW, sleep: async () => {} })).rejects.toThrow();
  });
  it('accepts the first valid new-version checkpoint after the boundary', async () => {
    let clock = NOW;
    const result = await waitForRolloverProgress(before, async () => {
      const c = collection(NEW, clock); c.observations += 5; c.batches += 5; c.archive.verifiedObjects += 5; return c;
    }, NEW, NOW, { clock: () => clock, sleep: async (ms: number) => { clock += ms; } });
    expect(result.boundaryAt).toBe(NOW + CODE_DEFERRAL_MS); expect(result.checkpoint.completedAttempt).toBeGreaterThan(result.boundaryAt);
  });
});
