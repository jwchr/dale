import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { HistoryJournal, historyContextKey, type HistoryStorage } from '../../worker/history-journal';
import { HistoryArchive, type HistoryBucket } from '../../worker/history-archive';
import { liveDataset as ds, NOW } from '../helpers/liveBus';

describe('hot history cleanup after a long archive outage', () => {
  it('returns to the 6-hour hot window once the archive catches up', async () => {
    const db = new DatabaseSync(':memory:');
    const storage: HistoryStorage = {
      sql: { get databaseSize() { return 1000; }, exec(q, ...b) { const rows = db.prepare(q).all(...(b as never[])) as Record<string, unknown>[]; return { toArray: () => rows }; } },
      transactionSync<T>(cb: () => T): T { db.exec('BEGIN'); try { const v = cb(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    };
    const journal = new HistoryJournal(storage, ds, await historyContextKey(ds));
    journal.setEnabled(true, NOW);
    let down = true; const objects = new Map<string, Uint8Array>();
    const bucket: HistoryBucket = {
      async put(k, body) { if (down) throw new Error('archive down'); if (objects.has(k)) return null; objects.set(k, new Uint8Array(body.slice(0))); return {}; },
      async get(k) { const s = objects.get(k); if (!s) return null; return { size: s.byteLength, async arrayBuffer() { return s.slice().buffer; } }; },
    };
    const archive = new HistoryArchive(storage, journal, bucket);
    const unavailable = { feed: { state: 'unavailable' as const }, observations: [], updates: [] };
    const rows = () => Number(db.prepare('SELECT COUNT(*) c FROM dale_history_batches').get()!.c);
    let t = NOW + 1000;
    // 12-hour archive outage (longer than the 6-hour hot window), then 60 more hours of 30-second polls.
    for (let i = 0; i < 2880 * 3; i++) {
      if (t - NOW >= 12 * 3600_000) down = false;
      const attempt = journal.beginAttempt(t); if (attempt !== undefined) journal.complete(attempt, unavailable, t);
      await archive.flush(t); journal.pruneVerified(t);
      t += 30_000;
    }
    // Every deleted row was archived and read back first; only the hot window (720 polls) remains.
    expect(db.prepare('SELECT COUNT(*) c FROM dale_history_batches WHERE archive_receipt IS NULL').get()!.c).toBeLessThanOrEqual(1);
    expect(rows()).toBeLessThanOrEqual(722);
  }, 120_000);
});
