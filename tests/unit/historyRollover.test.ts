import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryJournal, historyContextKey, HISTORY_HOT_MS, type HistoryStorage } from '../../worker/history-journal';
import { HistoryArchive, type HistoryBucket } from '../../worker/history-archive';
import { createFeedClass } from '../../worker/service';
import { createNormalizer } from '../../worker/normalize';
import type { Dataset } from '../../src/domain/types';
// @ts-expect-error native deployment helper
import { rolloverProgress } from '../../scripts/enabled-continuity.mjs';
import { liveDataset as ds, NOW, binaryFeed, vehicle, update } from '../helpers/liveBus';
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function sqlStorage() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const storage: HistoryStorage = {
    sql: { get databaseSize() { return Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size); },
      exec(query, ...bindings) { const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[]; return { toArray: () => rows }; } },
    transactionSync<T>(callback: () => T): T {
      db.exec('BEGIN'); try { const value = callback(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, storage };
}
function memoryBucket() {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const bucket: HistoryBucket = {
    async put(key, body) { if (objects.has(key)) return null; objects.set(key, new Uint8Array(body.slice(0))); return { key }; },
    async get(key) { const stored = objects.get(key); if (!stored) return null; const body = new Uint8Array(stored); return { size: body.byteLength, async arrayBuffer() { return body.buffer; } }; },
  };
  return { objects, bucket };
}
/** One poll at `at` with a fresh GPS fix, normalized against that schedule version. */
const poll = (schedule: Dataset, at: number) => createNormalizer(schedule)(binaryFeed([{ id: 'v', vehicle: vehicle({ timestamp: Math.floor(at / 1000) - 15 }) }], { timestamp: Math.floor(at / 1000) - 10 }), 'vehicles', at);
const next = (() => { const d = structuredClone(ds); d.meta.feedVersion = 'fedcba654321'; return d; })();
const json = (bytes: Uint8Array) => JSON.parse(gunzipSync(bytes).toString());
const manifest = (objects: Map<string, Uint8Array>, key: string) => JSON.parse(new TextDecoder().decode(objects.get(key)!));

describe('weekly schedule rollover on the same Durable Object storage', () => {
  it('keeps collecting: old batches archive under the old context, new batches under the new one, counters never reset', async () => {
    const { db, storage } = sqlStorage(), { objects, bucket } = memoryBucket();
    const oldKey = await historyContextKey(ds), oldJournal = new HistoryJournal(storage, ds, oldKey), oldArchive = new HistoryArchive(storage, oldJournal, bucket);
    oldJournal.setEnabled(true, NOW);
    oldJournal.complete(oldJournal.beginAttempt(NOW)!, poll(ds, NOW), NOW);
    await oldArchive.flush(NOW);
    // One more old-version batch is still unarchived when the code update lands.
    oldJournal.complete(oldJournal.beginAttempt(NOW + 30_000)!, poll(ds, NOW + 30_000), NOW + 30_000);
    const before = oldJournal.status(NOW + 30_000), archivedBefore = oldArchive.status(NOW + 30_000).verifiedObjects;
    expect(before).toMatchObject({ observations: 2, batches: 2, scheduleVersion: ds.meta.feedVersion });
    expect(archivedBefore).toBe(2);

    // The Durable Object is rebuilt with the new bundled schedule (service.ts constructor order).
    const newKey = await historyContextKey(next); expect(newKey).not.toBe(oldKey);
    const journal = new HistoryJournal(storage, next, newKey);
    journal.setEnabled(true, NOW + 60_000);
    const archive = new HistoryArchive(storage, journal, bucket);
    // The new context is stored before any new batch exists; nothing was reset.
    const started = journal.status(NOW + 60_000);
    expect(started).toMatchObject({ reason: 'starting', scheduleVersion: 'fedcba654321', scheduleContextStored: true, observations: 2, batches: 2 });
    expect(started.bytes).toBeGreaterThan(before.bytes);
    expect(db.prepare('SELECT count(*) AS n FROM dale_history_batches WHERE context_key=?').get(newKey)).toEqual({ n: 0 });
    // The deploy-side classifier keeps waiting on this transient state.
    expect(rolloverProgress({}, { ...started, error: false }, 'fedcba654321', NOW, NOW + 60_000)).toBeUndefined();

    journal.complete(journal.beginAttempt(NOW + 60_000)!, poll(next, NOW + 60_000), NOW + 60_000);
    for (let i = 0; i < 4 && journal.nextUnarchived(); i++) await archive.flush(NOW + 60_000 + i);
    expect(journal.nextUnarchived()).toBeUndefined();
    const after = journal.status(NOW + 60_000);
    expect(after).toMatchObject({ reason: 'collecting', observations: 3, batches: 3 });
    // Old pending batch + new context + new batch.
    expect(archive.status(NOW + 60_000).verifiedObjects).toBe(archivedBefore + 3);

    const oldContext = journal.scheduleContext(oldKey).receipt!, newContext = journal.scheduleContext(newKey).receipt!;
    expect(oldContext.manifestKey).not.toBe(newContext.manifestKey);
    expect(json(objects.get(oldContext.key)!)).toEqual(ds); expect(json(objects.get(newContext.key)!)).toEqual(next);
    const rows = db.prepare('SELECT context_key,feed_version,archive_receipt FROM dale_history_batches ORDER BY attempt').all();
    expect(rows.map(r => r.context_key)).toEqual([oldKey, oldKey, newKey]);
    for (const row of rows) {
      const receipt = JSON.parse(String(row.archive_receipt));
      const expected = row.context_key === oldKey ? oldContext : newContext;
      expect(receipt.contextManifestKey).toBe(expected.manifestKey);
      expect(manifest(objects, receipt.manifestKey)).toMatchObject({ kind: 'batch', feedVersion: row.feed_version, contextManifestKey: expected.manifestKey });
      expect(json(objects.get(receipt.key)!).contextKey).toBe(row.context_key);
    }
    // Hot cleanup may drop the old context's local copy, never its archived object or manifest row.
    journal.pruneVerified(NOW + HISTORY_HOT_MS + 120_000);
    expect(journal.scheduleContext(oldKey).receipt).toEqual(oldContext);
    expect(objects.has(oldContext.key) && objects.has(oldContext.manifestKey)).toBe(true);
    expect(journal.status(NOW + HISTORY_HOT_MS + 120_000).observations).toBe(3);
  });

  it('documents a refused new context: old evidence stays intact, collection pauses and health reports the error', async () => {
    const { db, storage } = sqlStorage(), { objects, bucket } = memoryBucket();
    const oldKey = await historyContextKey(ds), oldJournal = new HistoryJournal(storage, ds, oldKey);
    oldJournal.setEnabled(true, NOW);
    oldJournal.complete(oldJournal.beginAttempt(NOW)!, poll(ds, NOW), NOW);
    const state = JSON.parse(String(db.prepare('SELECT body FROM dale_history_meta').get()!.body));
    state.reservedWrites = 75_000 - 3; db.prepare('UPDATE dale_history_meta SET body=?').run(JSON.stringify(state));
    const newKey = await historyContextKey(next), journal = new HistoryJournal(storage, next, newKey);
    expect(() => journal.setEnabled(true, NOW + 30_000)).toThrow('history-schedule-budget');
    expect(journal.status(NOW + 30_000)).toMatchObject({ enabled: true, scheduleVersion: 'fedcba654321', scheduleContextStored: false, observations: 1, batches: 1 });
    expect(journal.beginAttempt(NOW + 30_000)).toBeUndefined();
    expect(journal.status(NOW + 30_000).reason).toBe('schedule-context-unavailable');
    expect(journal.nextUnarchived()).toMatchObject({ contextKey: oldKey });
    expect(journal.scheduleContext(oldKey).body).toBe(JSON.stringify(ds));
    expect(db.prepare('SELECT count(*) AS n FROM dale_history_schedules WHERE feed_version=?').get(newKey)).toEqual({ n: 0 });
    // With the daily write budget spent, even a journal-level archive makes no bucket call.
    // service.ts creates no archive at all after this refusal (next test): current behavior.
    await new HistoryArchive(storage, journal, bucket).flush(NOW + 30_000);
    expect(objects.size).toBe(0);
  });

  it('service health after a refused context matches the deploy fail-fast signal and makes no upstream request', async () => {
    const { db, storage: sql } = sqlStorage();
    let now = NOW, alarmAt: number | null = null; const saved = new Map<string, unknown>(), calls: string[] = [];
    const storage = { ...sql, get: async <T,>(key: string) => structuredClone(saved.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => { saved.set(key, structuredClone(value)); },
      getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; } };
    const net = (async (url: RequestInfo | URL) => {
      const endpoint = String(url).split('/').pop()!; calls.push(endpoint);
      if (endpoint === 'authenticateUser') return Response.json({ Authenticated: 'True', UserToken: 'private-test-token' });
      const seconds = Math.floor(now / 1000);
      return new Response(new Uint8Array(binaryFeed([{ id: endpoint, ...(endpoint === 'getVehiclePositions' ? { vehicle: vehicle({ timestamp: seconds - 1 }) } : { tripUpdate: update({ timestamp: seconds - 1 }) }) }], { timestamp: seconds - 1 })).buffer);
    }) as typeof fetch;
    const ctx = { storage, blockConcurrencyWhile: async <T,>(callback: () => Promise<T>) => callback() };
    const env = { NJT_API_USERNAME: 'synthetic', NJT_API_PASSWORD: 'synthetic', HISTORY_COLLECTION: 'enabled', FEED: { idFromName: () => 'one', get: () => { throw new Error('unused'); } } };
    const health = async (object: { fetch(r: Request): Promise<Response> }) => (await (await object.fetch(new Request('https://test/v1/collection'))).json()).collection;
    const Old = createFeedClass(ds, net, () => now), oldObject = new Old(ctx, env);
    alarmAt = null; await oldObject.alarm();
    expect(await health(oldObject)).toMatchObject({ observations: 1, batches: 1, error: false });
    const state = JSON.parse(String(db.prepare('SELECT body FROM dale_history_meta').get()!.body));
    state.reservedWrites = 75_000 - 3; db.prepare('UPDATE dale_history_meta SET body=?').run(JSON.stringify(state));
    now = NOW + 30_000; const upstream = calls.length;
    const New = createFeedClass(next, net, () => now), newObject = new New(ctx, env);
    const refused = await health(newObject);
    expect(refused).toMatchObject({ error: true, scheduleVersion: 'fedcba654321', scheduleContextStored: false, observations: 1, batches: 1 });
    expect(() => rolloverProgress({}, refused, 'fedcba654321', NOW, now)).toThrow('rollover-context-admission-failed');
    alarmAt = null; await newObject.alarm();
    expect(calls.length).toBe(upstream);
    expect(await health(newObject)).toMatchObject({ error: true, reason: 'schedule-context-unavailable', observations: 1, batches: 1 });
  });
});
