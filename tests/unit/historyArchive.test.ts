import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryJournal, historyContextKey, HISTORY_HOT_MS, type HistoryStorage } from '../../worker/history-journal';
import { HistoryArchive, type HistoryBucket } from '../../worker/history-archive';
import { createNormalizer } from '../../worker/normalize';
import { liveDataset as ds, NOW, binaryFeed, vehicle } from '../helpers/liveBus';
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function harness() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const storage: HistoryStorage = {
    sql: { get databaseSize() { return Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size); },
      exec(query, ...bindings) { const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[]; return { toArray: () => rows }; } },
    transactionSync<T>(callback: () => T): T {
      db.exec('BEGIN'); try { const value = callback(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  const contextKey = await historyContextKey(ds), journal = new HistoryJournal(storage, ds, contextKey);
  journal.setEnabled(true, NOW);
  const feed = createNormalizer(ds)(binaryFeed([{ id: 'v', vehicle: vehicle() }]), 'vehicles', NOW);
  journal.complete(journal.beginAttempt(NOW)!, feed, NOW);
  const objects = new Map<string, Uint8Array<ArrayBuffer>>(), calls: string[] = [];
  let mode = '', throwAfterWrite = false, reads = 0;
  const bucket: HistoryBucket = {
    async put(key, body, options) {
      // Real tests assert pre-I/O persistent reservations, not a later counter.
      const ledger = db.prepare('SELECT SUM(class_a) AS a,SUM(class_b) AS b FROM dale_archive_days').get()!;
      expect(Number(ledger.a)).toBeGreaterThanOrEqual(2); expect(Number(ledger.b)).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(String(db.prepare('SELECT body FROM dale_archive_meta').get()!.body)).reservedBytes).toBeGreaterThanOrEqual(body.byteLength);
      expect(options.onlyIf).toEqual({ etagDoesNotMatch: '*' }); expect(options.storageClass).toBe('Standard');
      expect(new Uint8Array(await crypto.subtle.digest('SHA-256', body))).toEqual(new Uint8Array(options.sha256));
      calls.push('put:' + key);
      if (objects.has(key)) return null;
      objects.set(key, new Uint8Array(body.slice(0)));
      if (throwAfterWrite) { throwAfterWrite = false; throw new Error('synthetic ambiguous completion'); }
      return { key };
    },
    async get(key) {
      calls.push('get:' + key); const stored = objects.get(key); if (!stored) return null;
      const body = new Uint8Array(stored), manifest = key.endsWith('.manifest.json');
      if (mode === 'data-corrupt' && !manifest) body[body.length - 1] = body[body.length - 1]! ^ 1;
      if (mode === 'manifest-corrupt' && manifest) body[0] = body[0]! ^ 1;
      return { size: mode === 'oversize' ? 20_000_001 : body.byteLength,
        async arrayBuffer() { reads++; return mode === 'truncated' ? body.slice(0, -1).buffer : body.buffer; } };
    },
  };
  const archive = new HistoryArchive(storage, journal, bucket);
  return { db, storage, journal, bucket, archive, objects, calls, contextKey, mode: (value: string) => { mode = value; },
    ambiguousWrite: () => { throwAfterWrite = true; }, readCount: () => reads };
}
describe('verified permanent private archive', () => {
  it('verifies lossless source context and evidence before allowing hot cleanup, preserving R2 indefinitely', async () => {
    const h = await harness(), original = h.journal.nextUnarchived()!;
    h.journal.pruneVerified(NOW + 365 * 86400_000);
    expect(h.journal.nextUnarchived()).toEqual(original);
    await h.archive.flush(NOW);
    expect(h.archive.status(NOW)).toMatchObject({ reason: 'ready', verifiedObjects: 2, classAReserved32Days: 4, classBReserved32Days: 4 });
    expect(h.objects.size).toBe(4);
    const receipt = JSON.parse(String(h.db.prepare('SELECT archive_receipt FROM dale_history_batches').get()!.archive_receipt));
    expect(gunzipSync(h.objects.get(receipt.key)!).toString()).toBe(original.body);
    const context = h.journal.scheduleContext(h.contextKey).receipt!;
    expect(JSON.parse(gunzipSync(h.objects.get(context.key)!).toString())).toEqual(ds);
    h.journal.pruneVerified(NOW + HISTORY_HOT_MS + 1);
    expect(h.journal.status(NOW + HISTORY_HOT_MS + 1)).toMatchObject({ batches: 0, observations: 1 });
    expect(h.objects.size).toBe(4); expect(h.journal.scheduleContext(h.contextKey).receipt).toEqual(context);
  });
  it.each(['data-corrupt', 'manifest-corrupt', 'truncated', 'oversize'])('preserves all unarchived evidence and context on %s readback', async mode => {
    const h = await harness(); h.mode(mode); await h.archive.flush(NOW);
    expect(h.archive.status(NOW).reason).toBe('archive-error');
    h.journal.pruneVerified(NOW + 365 * 86400_000);
    expect(h.journal.nextUnarchived()).toBeDefined();
    expect(h.journal.scheduleContext(h.contextKey).body).toBe(JSON.stringify(ds));
    expect(h.journal.scheduleContext(h.contextKey).receipt).toBeUndefined();
    if (mode === 'oversize') expect(h.readCount()).toBe(0);
  });
  it('resumes an ambiguous completed write after eviction without duplicate objects or refunded reservations', async () => {
    const h = await harness(); h.ambiguousWrite(); await h.archive.flush(NOW);
    expect(h.objects.size).toBe(1); const reserved = h.archive.status(NOW).reservedBytes;
    const resumed = new HistoryArchive(h.storage, h.journal, h.bucket);
    await resumed.flush(NOW + 1000); expect(h.objects.size).toBe(1);
    await resumed.flush(NOW + 61_000);
    expect(h.objects.size).toBe(4); expect(resumed.status(NOW + 61_000).verifiedObjects).toBe(2);
    expect(resumed.status(NOW + 61_000).reservedBytes).toBeGreaterThan(reserved);
    expect(resumed.status(NOW + 61_000).classAReserved32Days).toBe(6);
  });
  it('retries a verified remote manifest after a failed local acknowledgment without deleting the local sample', async () => {
    const h = await harness();
    h.db.exec("CREATE TRIGGER fail_ack BEFORE UPDATE OF archive_receipt ON dale_history_batches BEGIN SELECT RAISE(ABORT,'synthetic ack failure'); END");
    await h.archive.flush(NOW); expect(h.objects.size).toBe(4); expect(h.journal.nextUnarchived()).toBeDefined();
    h.journal.pruneVerified(NOW + HISTORY_HOT_MS + 1); expect(h.journal.nextUnarchived()).toBeDefined();
    h.db.exec('DROP TRIGGER fail_ack'); await h.archive.flush(NOW + 61_000);
    expect(h.objects.size).toBe(4); expect(h.journal.nextUnarchived()).toBeUndefined();
  });
  it.each(['bytes', 'classA', 'classB', 'sql'])('makes zero bucket calls when the %s free budget is exhausted', async budget => {
    const h = await harness();
    if (budget === 'bytes') h.db.prepare('INSERT INTO dale_archive_meta(id,body) VALUES(1,?)').run(JSON.stringify({ v: 1, reservedBytes: 9_000_000_000, verifiedObjects: 0, failures: 0, reason: 'waiting' }));
    else if (budget === 'sql') {
      const state = JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_meta').get()!.body)); state.reservedWrites = 75_000;
      h.db.prepare('UPDATE dale_history_meta SET body=?').run(JSON.stringify(state));
    } else h.db.prepare('INSERT INTO dale_archive_days(day,class_a,class_b) VALUES(?,?,?)').run('2026-10-31', budget === 'classA' ? 500_000 : 0, budget === 'classB' ? 2_000_000 : 0);
    await h.archive.flush(NOW); expect(h.calls).toEqual([]); expect(h.journal.nextUnarchived()).toBeDefined();
    expect(h.archive.status(NOW).reason).toBe(budget === 'bytes' ? 'free-storage-budget' : budget === 'sql' ? 'sql-write-budget' : 'free-operation-budget');
  });
  it('does not reset operation allowance across a calendar-month boundary', async () => {
    const h = await harness(); h.db.prepare('INSERT INTO dale_archive_days(day,class_a,class_b) VALUES(?,?,?)').run('2026-10-31', 500_000, 0);
    await h.archive.flush(NOW); expect(h.calls).toEqual([]);
    await h.archive.flush(NOW + 35 * 86400_000); expect(h.archive.status(NOW + 35 * 86400_000).verifiedObjects).toBe(2);
  });
  it('retains old canonical context unless its original archive was verified first', async () => {
    const h = await harness(), nextDs = structuredClone(ds); nextDs.meta.feedVersion = 'next-version';
    const next = new HistoryJournal(h.storage, nextDs, await historyContextKey(nextDs)); next.setEnabled(true, NOW + 30_000);
    next.pruneVerified(NOW + HISTORY_HOT_MS + 1); expect(next.scheduleContext(h.contextKey).body).toBeDefined();
    await h.archive.flush(NOW); next.pruneVerified(NOW + HISTORY_HOT_MS + 1);
    expect(next.scheduleContext(h.contextKey).receipt).toBeDefined();
    expect(h.db.prepare('SELECT count(*) AS n FROM dale_history_schedules WHERE feed_version=? AND part>=0').get(h.contextKey)).toEqual({ n: 0 });
  });
  it('does not archive a same-size corrupted SQL source context under the original context identity', async () => {
    const h = await harness();
    const row = h.db.prepare('SELECT body FROM dale_history_schedules WHERE feed_version=? AND part=0').get(h.contextKey)!;
    const body = String(row.body), corrupt = body.replace('fixture-live', 'fixture-livf'); expect(corrupt).not.toBe(body);
    h.db.prepare('UPDATE dale_history_schedules SET body=? WHERE feed_version=? AND part=0').run(corrupt, h.contextKey);
    await h.archive.flush(NOW); expect(h.calls).toEqual([]); expect(h.journal.nextUnarchived()).toBeDefined();
    expect(h.archive.status(NOW).reason).toBe('archive-error');
  });
  it('identifies converter/context changes even when the upstream feed version is unchanged', async () => {
    const h = await harness(), changed = structuredClone(ds); changed.trips[0]!.times[0]! += 60;
    const contextKey = await historyContextKey(changed); expect(contextKey).not.toBe(h.contextKey);
    const journal = new HistoryJournal(h.storage, changed, contextKey); journal.setEnabled(true, NOW + 30_000);
    expect(journal.scheduleContext(contextKey).body).toBe(JSON.stringify(changed));
    expect(journal.scheduleContext(h.contextKey).body).toBe(JSON.stringify(ds));
  });
});
