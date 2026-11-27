import { A_LIMIT } from '../../worker/history-archive';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { ArrivalConfidence, FOLD_MS } from '../../worker/arrival-confidence';
import { ArrivalBackfill, parseBackfillLease, type ArchiveReader } from '../../worker/arrival-backfill';
import { HistoryJournal, type HistoryStorage } from '../../worker/history-journal';
import { createFeedClass, createRouter } from '../../worker/service';
import type { ConfidenceKey } from '../../src/domain/arrivalConfidence';
import { liveDataset as ds, NOW } from '../helpers/liveBus';

// Synthetic batches only: invented trips, a fake vehicle id and fake coordinates that must never reach any output.
const DAILY_WRITE_BUDGET = 1_000_000, databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function harness() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const storage: HistoryStorage = {
    sql: { get databaseSize() { return Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size); }, exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
      return { toArray: () => rows };
    } },
    transactionSync<T>(callback: () => T): T {
      db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  const journal = new HistoryJournal(storage, ds, ds.meta.feedVersion);
  journal.setEnabled(true, NOW);
  const spare = (units: number, now: number, keep?: number) => journal.reserveSpareWrites(units, now, keep);
  return { db, storage, journal, spare, confidence: new ArrivalConfidence(storage, ds, 'ctx') };
}
const at = (date: string, hhmm: string) => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${hhmm}:00-05:00`);
const record = (trip: string, observedAt: number, stop?: [number, string]) => ({ source: 'synthetic', route: '165', direction: 0,
  observation: { tripInstanceId: trip, vehicleId: 'SECRET-BUS-4417', observedAt, lat: 40.912345, lon: -74.054321,
    ...(stop ? { stopCall: { status: 'stopped_at', stopIndex: stop[0], stopId: stop[1] } } : {}) } });
const body = (contextKey: string, records: unknown[], feedVersion = ds.meta.feedVersion) => ({ v: 1, feedVersion, contextKey, records });
function insert(db: DatabaseSync, attempt: number, records: unknown[], contextKey = 'ctx') {
  const text = JSON.stringify(body(contextKey, records));
  db.prepare('INSERT INTO dale_history_batches(attempt,received_at,feed_version,context_key,bytes,body) VALUES(?,?,?,?,?,?)').run(attempt, attempt, ds.meta.feedVersion, contextKey, text.length, text);
}
const key: ConfidenceKey = { route: '165', direction: 0, stopId: '1', schedMinute: 420, dayType: 'weekday' };
const WEEKDAYS = ['20261102', '20261103', '20261104', '20261105', '20261106', '20261109'];
/** One weekday morning: moving at 6:58, first seen stopped at stop 1 at 7:03 (three minutes late). */
const morning = (db: DatabaseSync, date: string, late = '07:03') => {
  insert(db, at(date, '06:58'), [record(`T1@${date}`, at(date, '06:58'))]);
  insert(db, at(date, late), [record(`T1@${date}`, at(date, late), [0, '1'])]);
};
const PRIVATE = /SECRET|40\.91|74\.05|T1@|vehicle|"lat"|"lon"|tripInstance|v1\/20/;

describe('live fold inside the collector', () => {
  it('folds private hot batches into aggregates, seeds on the first retained minutes and counts a date once', () => {
    const h = harness();
    // The oldest retained batch: a bus already stopped here is continuity only, never a new arrival.
    insert(h.db, at('20261102', '06:50'), [record('T1@20261102', at('20261102', '06:50'), [0, '1'])]);
    for (const date of WEEKDAYS) morning(h.db, date);
    h.confidence.fold(NOW, h.spare);
    const answer = h.confidence.answer(key);
    expect(answer).toMatchObject({ state: 'ready', samples: 5, firstServiceDate: '2026-11-03', lastServiceDate: '2026-11-09' });
    if (answer.state === 'ready') expect(answer.oneMinute.find((b) => b.fromMinute === 3)?.count).toBe(5);
    const status = h.confidence.status();
    expect(status).toMatchObject({ available: true, reason: 'ready', folds: 1, arrivals: 5, rows: 1, cells: 1, possibleGaps: 0 });
    expect(JSON.stringify(status)).not.toMatch(PRIVATE);
    // Later the same trip shows up stopped at the same stop again: the trip already arrived there, still one sample.
    insert(h.db, at('20261109', '09:00'), [record('T1@20261109', at('20261109', '09:00'), [0, '1'])]);
    h.confidence.fold(NOW, h.spare);
    expect(h.confidence.status()).toMatchObject({ folds: 1 });
    h.confidence.fold(NOW + FOLD_MS, h.spare);
    expect(h.confidence.status()).toMatchObject({ folds: 2, arrivals: 5 });
    expect(h.confidence.answer(key)).toMatchObject({ samples: 5 });
    const stored = JSON.stringify(h.db.prepare('SELECT * FROM dale_arrival_rows').all()) + JSON.stringify(h.db.prepare('SELECT * FROM dale_arrival_meta').all());
    expect(stored).not.toMatch(/SECRET|40\.91|74\.05|vehicle|"lat"|"lon"/);
  });
  it('a refused write budget keeps the checkpoint and the next fold catches up; other schedules are skipped and counted', () => {
    const h = harness();
    insert(h.db, at('20261101', '06:00'), []);
    for (const date of WEEKDAYS) morning(h.db, date);
    insert(h.db, at('20261110', '07:03'), [record('T1@20261110', at('20261110', '07:03'), [0, '1'])], 'older-schedule');
    h.confidence.fold(NOW, () => false);
    expect(h.confidence.status()).toMatchObject({ checkpointAt: null, folds: 0, arrivals: 0, reason: 'waiting' });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM dale_arrival_rows').get()!.n).toBe(0);
    h.confidence.fold(NOW + FOLD_MS, h.spare);
    expect(h.confidence.status()).toMatchObject({ folds: 1, arrivals: 6, otherSchedule: 1, reason: 'ready' });
    expect(h.confidence.answer(key)).toMatchObject({ samples: 6 });
  });
  it('spare writes leave every remaining normal poll, the rollover margin and the caller keep untouched', () => {
    const h = harness();
    // Every other optional use also leaves statewide raw saving its 6 writes per remaining poll (Jeff's P0, Nov 26).
    const normal = Math.ceil((Date.parse('2026-11-05T00:00:00Z') - NOW) / 30_000) * (24 + 6) + 16;
    const room = DAILY_WRITE_BUDGET - h.journal.status(NOW).reservedWrites - normal;
    expect(h.journal.reserveSpareWrites(room - 10, NOW, 11)).toBe(false);
    expect(h.journal.reserveSpareWrites(room - 10, NOW, 10)).toBe(true);
    expect(h.journal.reserveSpareWrites(11, NOW)).toBe(false);
    expect(h.journal.reserveSpareWrites(10, NOW)).toBe(true);
    expect(h.journal.reserveSpareWrites(0, NOW)).toBe(false);
    const off = harness(); off.journal.setEnabled(false, NOW);
    expect(off.journal.reserveSpareWrites(1, NOW)).toBe(false);
  });
  it('statewide raw saving may use the lane every other optional use leaves free, never the normal polls (P0, Nov 26)', () => {
    const h = harness();
    const intervals = Math.ceil((Date.parse('2026-11-05T00:00:00Z') - NOW) / 30_000);
    const room = DAILY_WRITE_BUDGET - h.journal.status(NOW).reservedWrites - (intervals * 24 + 16);
    expect(h.journal.reserveSpareWrites(room - intervals * 6, NOW)).toBe(true);
    expect(h.journal.reserveSpareWrites(1, NOW)).toBe(false);
    expect(h.journal.reserveRawWrites(intervals * 6 + 1, NOW)).toBe(false);
    expect(h.journal.reserveRawWrites(intervals * 6, NOW)).toBe(true);
    expect(h.journal.reserveRawWrites(1, NOW)).toBe(false);
    const off = harness(); off.journal.setEnabled(false, NOW);
    expect(off.journal.reserveRawWrites(1, NOW)).toBe(false);
  });
});

describe('public arrival confidence endpoint', () => {
  const query = 'route=165&stop=1&dir=0&sched=07:00&day=weekday';
  it('the router refuses bad input without waking the Durable Object, and caches only a good answer', async () => {
    const router = createRouter(ds);
    let forwarded = 0, status = 200;
    const env = { ARRIVAL_CONFIDENCE: 'public', FEED: { idFromName: () => 'one', get: () => ({ fetch: async () => { forwarded++; return Response.json({ v: 1, state: 'insufficient' }, { status }); } }) } };
    const off = await router.fetch(new Request(`https://worker.test/v1/arrival-confidence?${query}`), { ...env, ARRIVAL_CONFIDENCE: undefined } as never);
    expect(off.status).toBe(404);
    expect(forwarded).toBe(0);
    const get = (q: string) => router.fetch(new Request(`https://worker.test/v1/arrival-confidence?${q}`), env as never);
    for (const bad of ['', 'route=165', `${query}&vehicle=1`, query.replace('07:00', '7am'), query.replace('stop=1', 'stop=9'), `${query}&pad=${'x'.repeat(600)}`]) {
      const response = await get(bad);
      expect(response.status, bad).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(forwarded).toBe(0);
    const good = await get(query);
    expect(good.status).toBe(200);
    expect(good.headers.get('cache-control')).toBe('public, max-age=600');
    expect(good.headers.get('access-control-allow-origin')).toBe('https://jwchr.github.io');
    status = 503;
    expect((await get(query)).headers.get('cache-control')).toBe('no-store');
    expect(forwarded).toBe(2);
    expect((await router.fetch(new Request(`https://worker.test/v1/arrival-confidence?${query}`, { method: 'POST' }), env as never)).status).toBe(405);
  });
  it('the Durable Object answers from SQLite only: no NJ Transit call, and health shows counts but no ids', async () => {
    const db = new DatabaseSync(':memory:'); databases.push(db);
    const calls: string[] = [], saved = new Map<string, unknown>();
    const storage = {
      sql: { get databaseSize() { return 4096; }, exec(q: string, ...b: (string | number | null)[]) { const rows = db.prepare(q).all(...b) as Record<string, unknown>[]; return { toArray: () => rows }; } },
      transactionSync<T>(callback: () => T): T { db.exec('BEGIN'); try { const r = callback(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
      get: async <T,>(k: string) => structuredClone(saved.get(k)) as T | undefined, put: async (k: string, v: unknown) => { saved.set(k, structuredClone(v)); },
      getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
    };
    const net = (async (url: RequestInfo | URL) => { calls.push(String(url)); throw new Error('no network in this test'); }) as typeof fetch;
    const Feed = createFeedClass(ds, net, () => NOW);
    const object = new Feed({ storage, blockConcurrencyWhile: async <T,>(cb: () => Promise<T>) => cb() }, {
      NJT_API_USERNAME: 'synthetic', NJT_API_PASSWORD: 'synthetic', HISTORY_COLLECTION: 'enabled', FEED: { idFromName: () => 'one', get: () => object } } as never);
    const answer = await object.fetch(new Request(`https://do.test/v1/arrival-confidence?${query}`));
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('public, max-age=600');
    expect(await answer.json()).toEqual({ v: 1, state: 'insufficient', samples: 0, minimumSamples: 5,
      query: { route: '165', direction: 0, stopId: '1', scheduled: '07:00', dayType: 'weekday' } });
    expect((await object.fetch(new Request('https://do.test/v1/arrival-confidence?route=165'))).status).toBe(400);
    const health = await (await object.fetch(new Request('https://do.test/v1/collection'))).json() as { arrivalConfidence: Record<string, unknown> };
    expect(health.arrivalConfidence).toMatchObject({ available: true, minimumSamples: 5, backfill: { configured: false } });
    expect(health.arrivalConfidence).not.toHaveProperty('continuity');
    expect(calls).toEqual([]);
  });
});

// A fake private archive in the real key layout, gzip and raw SHA-256 included.
function archive() {
  const objects = new Map<string, Uint8Array>();
  const sha = (raw: Uint8Array | string) => createHash('sha256').update(raw).digest('hex');
  const putBatch = (attempt: number, records: unknown[], contextKey: string, feedVersion = ds.meta.feedVersion) => {
    const raw = Buffer.from(JSON.stringify(body(contextKey, records, feedVersion)));
    const key = `v1/${new Date(attempt).toISOString().slice(0, 10)}/batches/${String(attempt).padStart(13, '0')}-${sha(raw)}.json.gz`;
    objects.set(key, gzipSync(raw)); return key;
  };
  const putSchedule = (version: string) => {
    const copy = structuredClone(ds); copy.meta.feedVersion = version;
    const raw = Buffer.from(JSON.stringify(copy)), hash = sha(raw);
    objects.set(`v1/schedules/${sha(version).slice(0, 24)}/${hash}.json.gz`, gzipSync(raw));
    return `${version}:${hash}`;
  };
  let lists = 0, gets = 0;
  // Test hooks: make the next R2 call slow, failing or hanging.
  const hooks: { onList?: () => void; onGet?: (key: string) => Promise<never> | undefined } = {};
  const reader: ArchiveReader = {
    async list({ prefix, limit, startAfter }) {
      lists++; hooks.onList?.();
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort();
      return { objects: keys.slice(0, limit).map((k) => ({ key: k, size: objects.get(k)!.byteLength })), truncated: keys.length > limit };
    },
    async get(k) {
      gets++;
      const override = hooks.onGet?.(k); if (override) return override;
      const bytes = objects.get(k);
      return bytes ? { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer } : null;
    },
  };
  return { objects, reader, hooks, putBatch, putSchedule, counts: () => ({ lists, gets }) };
}
const BACKFILL_DATES = ['20261109', '20261110', '20261111', '20261112', '20261113'];
const LATER = Date.parse('2026-11-14T15:00:00Z');
async function runToEnd(backfill: ArrivalBackfill, spare: (u: number, n: number, k?: number) => boolean, start = LATER) {
  for (let i = 0; i < 60; i++) {
    await backfill.step(start + i * 60_000, spare);
    const state = backfill.status().state;
    if (state === 'done' || state === 'expired') return i + 1;
  }
  throw new Error('backfill did not finish');
}

describe('archive backfill (manual, bounded, idempotent)', () => {
  it('dry-run writes no aggregate rows; apply adds; a replayed lease adds nothing', async () => {
    const h = harness(), a = archive();
    const oldContext = a.putSchedule('older-version');
    for (const date of BACKFILL_DATES) {
      const context = date === '20261113' ? oldContext : 'ctx';
      a.putBatch(at(date, '06:58'), [record(`T1@${date}`, at(date, '06:58'))], context, context === 'ctx' ? ds.meta.feedVersion : 'older-version');
      a.putBatch(at(date, '07:04'), [record(`T1@${date}`, at(date, '07:04'), [0, '1'])], context, context === 'ctx' ? ds.meta.feedVersion : 'older-version');
    }
    // An altered object: its bytes no longer match the checksum in its key.
    const tampered = a.putBatch(at('20261110', '08:00'), [], 'ctx');
    a.objects.set(tampered, gzipSync(Buffer.from('{"changed":true}')));
    const lease = (mode: string, offset: number) => `${mode}:${LATER + 24 * 3600_000 + offset}`;

    const dry = new ArrivalBackfill(h.storage, h.confidence, a.reader, ds, 'ctx', lease('dry-run', 0));
    await runToEnd(dry, h.spare);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM dale_arrival_rows').get()!.n).toBe(0);
    const dryStatus = dry.status();
    expect(dryStatus).toMatchObject({ configured: true, mode: 'dry-run', state: 'done', newArrivals: 5, alreadyCounted: 0, checksumFailures: 1, contextsRead: 1, contextUnavailable: 0 });
    expect(JSON.stringify(dryStatus)).not.toMatch(PRIVATE);

    const apply = new ArrivalBackfill(h.storage, h.confidence, a.reader, ds, 'ctx', lease('apply', 1));
    await runToEnd(apply, h.spare);
    expect(apply.status()).toMatchObject({ mode: 'apply', state: 'done', newArrivals: 5, alreadyCounted: 0, batchesReplayed: 10 });
    expect(h.confidence.answer(key)).toMatchObject({ state: 'ready', samples: 5, firstServiceDate: '2026-11-09', lastServiceDate: '2026-11-13' });

    const again = new ArrivalBackfill(h.storage, h.confidence, a.reader, ds, 'ctx', lease('apply', 2));
    await runToEnd(again, h.spare);
    expect(again.status()).toMatchObject({ state: 'done', newArrivals: 0, alreadyCounted: 5 });
    expect(h.confidence.answer(key)).toMatchObject({ samples: 5 });
    // The R2 operation ledger is shared with the archive and was charged for every step.
    const ledger = h.db.prepare('SELECT SUM(class_a) AS a, SUM(class_b) AS b FROM dale_archive_days').get()!;
    expect(Number(ledger.a)).toBe(a.counts().lists);
    expect(Number(ledger.b)).toBeGreaterThanOrEqual(a.counts().gets);
  });
  it('keeps backfilling once raw saving has used more than half of the Class A cap (Neon DEEP Nov 26, B1-4)', async () => {
    const h = harness(), a = archive();
    a.putBatch(at('20261109', '07:04'), [record('T1@20261109', at('20261109', '07:04'), [0, '1'])], 'ctx');
    const backfill = new ArrivalBackfill(h.storage, h.confidence, a.reader, ds, 'ctx', `apply:${LATER + 24 * 3600_000 + 3}`);
    h.db.prepare('INSERT INTO dale_archive_days(day,class_a,class_b) VALUES(?,?,?)').run(new Date(LATER).toISOString().slice(0, 10), A_LIMIT / 2 + 1000, 0);
    await runToEnd(backfill, h.spare);
    expect(a.counts().lists).toBeGreaterThan(0);
  });
  it('a finished or expired lease never restarts; a lease beyond 48 hours or malformed never starts', async () => {
    const h = harness(), a = archive();
    a.putBatch(at('20261109', '07:04'), [record('T1@20261109', at('20261109', '07:04'), [0, '1'])], 'ctx');
    expect(parseBackfillLease('apply:123')).toBeUndefined();
    expect(parseBackfillLease('delete:1763000000000')).toBeUndefined();
    const far = new ArrivalBackfill(h.storage, h.confidence, a.reader, ds, 'ctx', `apply:${LATER + 49 * 3600_000}`);
    await far.step(LATER, h.spare);
    expect(far.status()).toEqual({ configured: true, state: 'not-started' });
    const short = new ArrivalBackfill(h.storage, h.confidence, a.reader, ds, 'ctx', `apply:${LATER + 90_000}`);
    await short.step(LATER, h.spare);
    await short.step(LATER + 120_000, h.spare);
    expect(short.status()).toMatchObject({ state: 'expired' });
    const steps = (short.status() as { steps?: number }).steps;
    await short.step(LATER + 180_000, h.spare);
    expect(short.status()).toMatchObject({ state: 'expired', steps });
    expect(a.counts().lists).toBe(1);
  });
  it('loads a new archived schedule only first in a step and resumes the rest next step without losing a batch', async () => {
    const h = harness(), a = archive();
    ['a', 'b', 'c'].forEach((v, i) => a.putBatch(at('20261109', `07:0${i + 1}`), [], a.putSchedule(`old-${v}`), `old-${v}`));
    a.putBatch(at('20261109', '07:09'), [], a.putSchedule('old-missing').replace(/[a-f0-9]{64}$/, '0'.repeat(64)), 'old-missing');
    const backfill = new ArrivalBackfill(h.storage, h.confidence, a.reader, ds, 'ctx', `dry-run:${LATER + 3600_000}`);
    await backfill.step(LATER, h.spare); // 2026-11-08 has no batches
    await backfill.step(LATER + 1000, h.spare);
    expect(backfill.status()).toMatchObject({ day: '2026-11-09', contextsRead: 1, batchesReplayed: 1 });
    await runToEnd(backfill, h.spare, LATER + 60_000);
    expect(backfill.status()).toMatchObject({ state: 'done', contextsRead: 4, batchesReplayed: 3, contextUnavailable: 1 });
  });
  it('a transient schedule read failure keeps the cursor, backs off, and the lease still finishes with every arrival', async () => {
    const h = harness(), a = archive();
    const old = a.putSchedule('older-version');
    for (const date of BACKFILL_DATES) {
      a.putBatch(at(date, '06:58'), [record(`T1@${date}`, at(date, '06:58'))], old, 'older-version');
      a.putBatch(at(date, '07:04'), [record(`T1@${date}`, at(date, '07:04'), [0, '1'])], old, 'older-version');
    }
    let failures = 1;
    a.hooks.onGet = (k) => k.startsWith('v1/schedules/') && failures-- > 0 ? Promise.reject(new Error('synthetic R2 outage')) : undefined;
    const backfill = new ArrivalBackfill(h.storage, h.confidence, a.reader, ds, 'ctx', `apply:${LATER + 24 * 3600_000}`);
    await backfill.step(LATER, h.spare); // 2026-11-08 has no batches
    await backfill.step(LATER + 1000, h.spare);
    expect(backfill.status()).toMatchObject({ day: '2026-11-09', retryableFailures: 1, retries: 1, batchesReplayed: 0, contextUnavailable: 0, retryAt: LATER + 61_000 });
    const listed = a.counts().lists;
    await backfill.step(LATER + 30_000, h.spare); // still backing off: no R2 call
    expect(a.counts().lists).toBe(listed);
    await runToEnd(backfill, h.spare, LATER + 61_000);
    expect(backfill.status()).toMatchObject({ state: 'done', newArrivals: 5, retries: 0, contextUnavailable: 0, retryableFailures: 1 });
    expect(h.confidence.answer(key)).toMatchObject({ state: 'ready', samples: 5 });
  });
  it('one step-wide deadline covers listing, batch reads and the schedule load', async () => {
    const h = harness(), a = archive();
    const old = a.putSchedule('older-version');
    a.putBatch(at('20261109', '07:04'), [record('T1@20261109', at('20261109', '07:04'), [0, '1'])], old, 'older-version');
    let clock = 0, hang = true;
    a.hooks.onList = () => { clock += 4_990; }; // a slow listing uses almost the whole step
    a.hooks.onGet = (k) => k.startsWith('v1/schedules/') && hang ? new Promise<never>(() => {}) : undefined;
    const backfill = new ArrivalBackfill(h.storage, h.confidence, a.reader, ds, 'ctx', `dry-run:${LATER + 24 * 3600_000}`, () => clock);
    await backfill.step(LATER, h.spare); // 2026-11-08
    const started = Date.now();
    await backfill.step(LATER + 1000, h.spare);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(backfill.status()).toMatchObject({ day: '2026-11-09', retryableFailures: 1, batchesReplayed: 0, contextsRead: 1 });
    a.hooks.onList = undefined; hang = false;
    await runToEnd(backfill, h.spare, LATER + 61_000);
    expect(backfill.status()).toMatchObject({ state: 'done', batchesReplayed: 1, newArrivals: 1 });
  });
  it('running out of step time after some batches ends the step normally: no back-off, the next step resumes (Neon DEEP Nov 26, C1-1)', async () => {
    const h = harness(), a = archive();
    const old = a.putSchedule('older-version');
    ['07:01', '07:02', '07:03'].forEach((t) => a.putBatch(at('20261109', t), [record('T1@20261109', at('20261109', t), [0, '1'])], old, 'older-version'));
    let clock = 0, batchReads = 0;
    a.hooks.onGet = (k) => { if (k.includes('/batches/') && ++batchReads === 2) clock += 5_000; return undefined; }; // the second batch read finds the step's time used up
    const backfill = new ArrivalBackfill(h.storage, h.confidence, a.reader, ds, 'ctx', `dry-run:${LATER + 24 * 3600_000}`, () => clock);
    await backfill.step(LATER, h.spare); // 2026-11-08
    await backfill.step(LATER + 1000, h.spare);
    expect(backfill.status()).toMatchObject({ day: '2026-11-09', batchesReplayed: 1, retries: 0, retryableFailures: 0 });
    expect('retryAt' in backfill.status()).toBe(false);
    await backfill.step(LATER + 2000, h.spare); // resumes right away, at the batch that ran out of time
    expect(backfill.status()).toMatchObject({ batchesReplayed: 3, retries: 0 });
    await runToEnd(backfill, h.spare, LATER + 3000);
    expect(backfill.status()).toMatchObject({ state: 'done', batchesReplayed: 3, retryableFailures: 0 });
  });
  it('reserves at least every row it writes, in the live fold and in both backfill modes', async () => {
    const h = harness(), a = archive();
    for (const date of BACKFILL_DATES) {
      a.putBatch(at(date, '06:58'), [record(`T1@${date}`, at(date, '06:58'))], 'ctx');
      a.putBatch(at(date, '07:04'), [record(`T1@${date}`, at(date, '07:04'), [0, '1'])], 'ctx');
    }
    h.journal.reserveSpareWrites(1, LATER); // roll the budget day so the deltas below are same-day
    const reserved = () => h.journal.status(LATER).reservedWrites;
    const written = () => Number(h.db.prepare('SELECT total_changes() AS n').get()!.n);
    const measure = async (work: () => Promise<unknown> | unknown) => {
      const r = reserved(), w = written(); await work(); return { reserved: reserved() - r, written: written() - w };
    };
    for (const [n, mode] of ['dry-run', 'apply', 'apply'].entries()) {
      const backfill = new ArrivalBackfill(h.storage, h.confidence, a.reader, ds, 'ctx', `${mode}:${LATER + 24 * 3600_000 + n}`);
      // Every single step, not only the total.
      for (let i = 0; i < 60 && !['done', 'expired'].includes(String(backfill.status().state)); i++) {
        const step = await measure(() => backfill.step(LATER + i * 60_000, h.spare));
        expect(step.written, `${mode} step ${i}`).toBeLessThanOrEqual(step.reserved);
        expect(step.written, `${mode} step ${i}`).toBeGreaterThan(0);
      }
      expect(backfill.status().state).toBe('done');
    }
    for (const date of WEEKDAYS) morning(h.db, date);
    const live = await measure(() => h.confidence.fold(LATER + 3600_000, h.spare));
    expect(live.written).toBeGreaterThan(0);
    expect(live.written).toBeLessThanOrEqual(live.reserved);
    const refused = await measure(() => h.confidence.fold(LATER + 2 * 3600_000, (u, n, k) => u <= 2 && h.spare(u, n, k)));
    expect(refused.written).toBeLessThanOrEqual(refused.reserved);
  });
  it('waits instead of reading when spare writes are not available', async () => {
    const h = harness(), a = archive();
    a.putBatch(at('20261109', '07:04'), [record('T1@20261109', at('20261109', '07:04'), [0, '1'])], 'ctx');
    const backfill = new ArrivalBackfill(h.storage, h.confidence, a.reader, ds, 'ctx', `apply:${LATER + 3600_000}`);
    await backfill.step(LATER, () => false);
    expect(a.counts()).toEqual({ lists: 0, gets: 0 });
    expect(backfill.status()).toEqual({ configured: true, state: 'not-started' });
  });
});
