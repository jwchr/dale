import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryJournal, type HistoryStorage } from '../../worker/history-journal';
import { createNormalizer } from '../../worker/normalize';
import { liveDataset as ds, NOW, binaryFeed, vehicle } from '../helpers/liveBus';
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function harness() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const storage: HistoryStorage = {
    // Like Workers, the cursor executes eagerly even if its rows are ignored.
    sql: { get databaseSize() { return Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size); }, exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
      return { toArray: () => rows };
    } },
    transactionSync<T>(callback: () => T): T {
      db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, storage, journal: new HistoryJournal(storage, ds, ds.meta.feedVersion) };
}
const feed = () => createNormalizer(ds)(binaryFeed([{ id: 'v', vehicle: vehicle() }]), 'vehicles', NOW);
describe('private SQLite history journal', () => {
  it('starts disabled, survives recreation and deduplicates repeated completed/alarm work', () => {
    const h = harness(); expect(h.journal.beginAttempt(NOW)).toBeUndefined();
    h.journal.setEnabled(true, NOW); const attempt = h.journal.beginAttempt(NOW)!;
    h.journal.complete(attempt, feed(), NOW); h.journal.complete(attempt, feed(), NOW);
    const resumed = new HistoryJournal(h.storage, ds, ds.meta.feedVersion);
    expect(resumed.status(NOW)).toMatchObject({ enabled: true, observations: 1, batches: 1, reason: 'collecting' });
    const next = resumed.beginAttempt(NOW + 30_000)!; resumed.complete(next, feed(), NOW + 30_000);
    expect(resumed.status(NOW + 30_000)).toMatchObject({ observations: 1, batches: 2, duplicates: 1 });
    expect(resumed.status(NOW)).not.toHaveProperty('watermarks');
  });
  it('rolls back both bundle and dedupe checkpoint when SQLite persistence fails', () => {
    const h = harness(); h.journal.setEnabled(true, NOW); const attempt = h.journal.beginAttempt(NOW)!;
    h.db.exec("CREATE TRIGGER fail_meta BEFORE UPDATE ON dale_history_meta BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    expect(() => h.journal.complete(attempt, feed(), NOW)).toThrow();
    expect(h.db.prepare('SELECT count(*) AS n FROM dale_history_batches').get()).toEqual({ n: 0 });
    h.db.exec('DROP TRIGGER fail_meta'); h.journal.complete(attempt, feed(), NOW);
    expect(h.journal.status(NOW).observations).toBe(1);
  });
  it('stops in-flight recording and retains existing evidence when disabled or the static version changes', () => {
    const h = harness(); h.journal.setEnabled(true, NOW); const attempt = h.journal.beginAttempt(NOW)!;
    h.journal.setEnabled(false, NOW + 1); h.journal.complete(attempt, feed(), NOW + 1);
    expect(h.journal.status(NOW).observations).toBe(0);
    h.journal.setEnabled(true, NOW + 30_000); h.journal.complete(h.journal.beginAttempt(NOW + 30_000)!, feed(), NOW + 30_000);
    const changed = structuredClone(ds); changed.meta.feedVersion = 'new-static-version';
    const next = new HistoryJournal(h.storage, changed, changed.meta.feedVersion);
    next.setEnabled(true, NOW + 30_000);
    expect(next.status(NOW + 30_000).batches).toBe(1);
    expect(h.db.prepare('SELECT feed_version FROM dale_history_batches').get()).toEqual({ feed_version: ds.meta.feedVersion });
    expect(h.db.prepare('SELECT count(*) AS n FROM dale_history_schedules WHERE part=-1').get()).toEqual({ n: 2 });
    const originalContext = h.db.prepare('SELECT body FROM dale_history_schedules WHERE feed_version=? AND part>=0 ORDER BY part').all(ds.meta.feedVersion)
      .map(row => String(row.body)).join('');
    expect(JSON.parse(originalContext)).toEqual(ds);
  });
  it('marks feed gaps and preserves older evidence indefinitely instead of deleting it after three days', () => {
    const h = harness(); h.journal.setEnabled(true, NOW); h.journal.complete(h.journal.beginAttempt(NOW)!, feed(), NOW);
    const later = NOW + 365 * 86400_000;
    const missing = { feed: { state: 'unavailable' as const }, observations: [], updates: [] };
    h.journal.complete(h.journal.beginAttempt(later)!, missing, later);
    expect(h.journal.status(later)).toMatchObject({ reason: 'feed-gap', gapSince: later, observations: 1, batches: 2,
      retention: 'indefinite-archive-before-hot-prune', oldestRetainedAt: NOW });
    const retained = JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_batches ORDER BY attempt DESC LIMIT 1').get()!.body));
    expect(retained).toMatchObject({ quality: { feedState: 'unavailable' }, records: [] });
  });
  it('pauses before the daily write reservation budget and resumes only after the UTC reset', () => {
    const h = harness(); h.journal.setEnabled(true, NOW);
    const state = JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_meta').get()!.body));
    state.reservedWrites = 75_000; h.db.prepare('UPDATE dale_history_meta SET body=?').run(JSON.stringify(state));
    expect(h.journal.beginAttempt(NOW)).toBeUndefined(); expect(h.journal.status(NOW).reason).toBe('quota-paused');
    const tomorrow = Date.parse('2026-11-05T00:00:00Z');
    expect(h.journal.beginAttempt(tomorrow)).toBe(tomorrow); expect(h.journal.status(tomorrow).reservedWrites).toBe(12);
  });
  it('fails closed on oversized evidence without advancing its dedupe checkpoint', () => {
    const h = harness(), many = feed(), original = many.observations[0]!;
    many.observations = Array.from({ length: 500 }, (_, i) => ({ ...original, vehicleId: `bus-${i}` }));
    h.journal.setEnabled(true, NOW); h.journal.complete(h.journal.beginAttempt(NOW)!, many, NOW);
    expect(h.journal.status(NOW)).toMatchObject({ reason: 'payload-limit', observations: 0, batches: 1 });
    const state = JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_meta').get()!.body));
    expect(state.watermarks).toEqual({});
  });
  it('keeps a storage-limit gap explicit instead of dropping old evidence to make a new sample fit', () => {
    const h = harness(); h.journal.setEnabled(true, NOW);
    const state = JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_meta').get()!.body));
    state.bytes = 249_999_999; h.db.prepare('UPDATE dale_history_meta SET body=?').run(JSON.stringify(state));
    h.journal.complete(h.journal.beginAttempt(NOW)!, feed(), NOW);
    expect(h.journal.status(NOW)).toMatchObject({ reason: 'storage-limit', observations: 0, batches: 0, bytes: 249_999_999 });
  });
  it('halts background work below the platform database limit and uses a slow capacity retry', () => {
    const h = harness(); h.journal.setEnabled(true, NOW);
    const before = h.journal.status(NOW).reservedWrites;
    Object.defineProperty(h.storage.sql, 'databaseSize', { get: () => 500_000_000 });
    expect(h.journal.beginAttempt(NOW)).toBeUndefined();
    expect(h.journal.status(NOW)).toMatchObject({ reason: 'storage-limit', nextAttemptAt: NOW + 3600_000, reservedWrites: before });
  });
  it('archives cancellation/skip context separately and excludes prediction values', () => {
    const h = harness(); h.journal.setEnabled(true, NOW);
    h.journal.complete(h.journal.beginAttempt(NOW)!, feed(), NOW, {
      feed: { state: 'ok', timestamp: NOW - 1000 }, observations: [],
      updates: [{ tripInstanceId: 'T1@20261104', observedAt: NOW - 1000, cancelled: true, skippedStops: [1],
        predictions: [{ stopIndex: 1, at: NOW + 60_000, observedAt: NOW - 1000, kind: 'arrival' }] }],
    });
    const body = JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_batches').get()!.body));
    expect(body.tripChanges).toEqual([{ tripInstanceId: 'T1@20261104', observedAt: NOW - 1000, cancelled: true, skippedStops: [1] }]);
    expect(body.records).toHaveLength(1); expect(JSON.stringify(body)).not.toContain('predictions');
  });
  it('retains unchanged matched-bus presence without counting it as a second GPS observation', () => {
    const h = harness(); h.journal.setEnabled(true, NOW);
    h.journal.complete(h.journal.beginAttempt(NOW)!, feed(), NOW);
    h.journal.complete(h.journal.beginAttempt(NOW + 30_000)!, feed(), NOW + 30_000);
    const second = JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_batches ORDER BY attempt DESC LIMIT 1').get()!.body));
    expect(second.records).toEqual([]);
    expect(second.census).toEqual([{ vehicleId: 'bus-A', tripId: 'T1', tripInstanceId: 'T1@20261104', routeId: '10', observedAt: NOW - 15_000, qualification: 'matched' }]);
    expect(second.quality.censusAvailable).toBe(true);
    expect(h.journal.status(NOW + 30_000).observations).toBe(1);
  });
  it('measures representative synthetic bundle growth and verifies a lossless gzip estimate', () => {
    const scenarios = [];
    for (const buses of [10, 50, 100]) {
      const h = harness(), sizing = structuredClone(ds), trip = sizing.trips.find(t => t.id === 'T1')!;
      sizing.meta.feedVersion = 'SYNTHETIC-SIZING';
      sizing.trips = Array.from({ length: buses }, (_, i) => ({ ...trip, id: `sizing-trip-${i}` }));
      const journal = new HistoryJournal(h.storage, sizing, sizing.meta.feedVersion), normalize = createNormalizer(sizing);
      journal.setEnabled(true, NOW); const initial = journal.status(NOW);
      for (let poll = 0; poll < 20; poll++) {
        const at = NOW + poll * 30_000;
        const packet = binaryFeed(Array.from({ length: buses }, (_, i) => ({ id: `sizing-${i}`, vehicle: vehicle({
          trip: { tripId: `sizing-trip-${i}`, startDate: '20261104', routeId: '10', directionId: 0 },
          vehicle: { id: `sizing-bus-${i}` }, timestamp: at / 1000 - 1,
          position: { latitude: 40.8 + i / 1000 + poll / 1_000_000, longitude: -74.04 - i / 1000 },
        }) })), { timestamp: at / 1000 - 1 });
        journal.complete(journal.beginAttempt(at)!, normalize(packet, 'vehicles', at), at);
      }
      let bytes = 0, gzipBytes = 0;
      for (const row of h.db.prepare('SELECT body FROM dale_history_batches').all()) {
        const text = String(row.body), gzip = gzipSync(text);
        expect(gunzipSync(gzip).toString()).toBe(text); bytes += Buffer.byteLength(text); gzipBytes += gzip.byteLength;
      }
      expect(journal.status(NOW + 600_000).observations).toBe(buses * 20);
      scenarios.push({ buses, polls: 20, pollSeconds: 30, payloadBytes: bytes, sqliteGrowthBytes: h.storage.sql.databaseSize - initial.databaseBytes,
        losslessGzipBytes: gzipBytes, rawBytesPerDayAtContinuousScenarioLoad: bytes / 20 * 2880,
        daysToPayloadCapAtScenarioLoad: (250_000_000 - initial.bytes) / (bytes / 20 * 2880) });
    }
    if (process.env.DALE_SIZING_FILE && !process.env.GITHUB_ACTIONS) writeFileSync(process.env.DALE_SIZING_FILE,
      JSON.stringify({ source: 'SYNTHETIC representative sizing using actual journal, SQLite and lossless gzip roundtrip. NOT agency cadence or live traffic.', scenarios }, null, 2) + '\n');
    expect(scenarios.every(s => s.losslessGzipBytes < s.payloadBytes && s.sqliteGrowthBytes > 0)).toBe(true);
  });
});

it('replacement retains an incomplete attempt, its spent reservation and prior originals before the next completion',()=>{
 const h=harness();h.journal.setEnabled(true,NOW);
 h.journal.complete(h.journal.beginAttempt(NOW)!,feed(),NOW);
 const original=h.db.prepare('SELECT body FROM dale_history_batches WHERE attempt=?').get(NOW)!.body;
 const interrupted=h.journal.beginAttempt(NOW+30000)!;
 const reserved=h.journal.status(NOW+30000).reservedWrites;
 const replacement=new HistoryJournal(h.storage,ds,ds.meta.feedVersion);
 expect(replacement.status(NOW+30001)).toMatchObject({enabled:true,lastAttemptAt:interrupted,completedAttempt:NOW,incompleteAttempt:true,reservedWrites:reserved});
 replacement.setCadenceTest(String(NOW+210000),NOW+30000);
 const next=replacement.beginAttempt(NOW+35000)!;
 expect(next).toBe(NOW+35000);
 expect(replacement.status(NOW+35000)).toMatchObject({incompleteAttempt:true,gapSince:interrupted});
 expect(replacement.status(NOW+35000).reservedWrites).toBeGreaterThan(reserved);
 expect(h.db.prepare('SELECT body FROM dale_history_batches WHERE attempt=?').get(NOW)!.body).toBe(original);
});

it('persists interrupted-attempt quality through capacity refusal and failed acknowledgment, clearing only after atomic batch insert',()=>{
 const h=harness();h.journal.setEnabled(true,NOW);
 h.journal.complete(h.journal.beginAttempt(NOW)!,feed(),NOW);
 const original=h.db.prepare('SELECT body FROM dale_history_batches WHERE attempt=?').get(NOW)!.body;
 h.journal.beginAttempt(NOW+30000);
 const size=Object.getOwnPropertyDescriptor(h.storage.sql,'databaseSize')!;
 Object.defineProperty(h.storage.sql,'databaseSize',{configurable:true,get:()=>500000000});
 const restarted=new HistoryJournal(h.storage,ds,ds.meta.feedVersion);
 expect(restarted.beginAttempt(NOW+60000)).toBeUndefined();
 expect(restarted.status(NOW+60000)).toMatchObject({pendingInterruptionCount:1,incompleteAttempt:true});
 expect(restarted.beginAttempt(NOW+90000)).toBeUndefined();
 expect(restarted.status(NOW+90000).pendingInterruptionCount).toBe(1);
 Object.defineProperty(h.storage.sql,'databaseSize',size);
 const attempt=restarted.beginAttempt(NOW+120000)!;
 h.db.exec("CREATE TRIGGER fail_interruption_ack BEFORE UPDATE ON dale_history_meta BEGIN SELECT RAISE(ABORT,'synthetic failed ack'); END");
 expect(()=>restarted.complete(attempt,feed(),NOW+120000)).toThrow();
 expect(restarted.status(NOW+120000).pendingInterruptionCount).toBe(1);
 expect(h.db.prepare('SELECT body FROM dale_history_batches WHERE attempt=?').get(attempt)).toBeUndefined();
 h.db.exec('DROP TRIGGER fail_interruption_ack');
 restarted.complete(attempt,feed(),NOW+120000);
 expect(restarted.status(NOW+120000).pendingInterruptionCount).toBe(0);
 const batch=JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_batches WHERE attempt=?').get(attempt)!.body));
 expect(batch.quality.collectorInterruptions).toMatchObject({kind:'interrupted-collector-attempt',details:[{attemptAt:NOW+30000,contextKey:ds.meta.feedVersion,contextUnknown:false}],omittedAttemptDetails:0});
 expect(h.db.prepare('SELECT body FROM dale_history_batches WHERE attempt=?').get(NOW)!.body).toBe(original);
 expect(JSON.stringify(restarted.status(NOW+120000))).not.toMatch(/pendingCollectorInterruptions|lastAttemptContextKey|lastRecordedInterruptionAt/);
});
it('bounds interruption details with explicit omitted-count/range and never invents legacy context',()=>{
 const h=harness();h.journal.setEnabled(true,NOW);h.journal.setCadenceTest(String(NOW+180000),NOW);
 for(let i=0;i<=30;i++)h.journal.beginAttempt(NOW+i*5000);
 const state=JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_meta').get()!.body));
 expect(state.pendingCollectorInterruptions.details).toHaveLength(16);
 expect(state.pendingCollectorInterruptions.omittedAttemptDetails).toBe(14);
 h.journal.complete(NOW+150000,feed(),NOW+150000);
 const body=JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_batches WHERE attempt=?').get(NOW+150000)!.body));
 expect(body.quality.collectorInterruptions).toMatchObject({omittedAttemptDetails:14,firstOmittedAttemptAt:NOW+80000,lastOmittedAttemptAt:NOW+145000});
 expect(h.journal.status(NOW+150000).pendingInterruptionCount).toBe(0);
 const legacy=JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_meta').get()!.body));
 legacy.lastAttemptAt=NOW+155000;delete legacy.lastAttemptContextKey;
 h.db.prepare('UPDATE dale_history_meta SET body=?').run(JSON.stringify(legacy));
 h.journal.complete(h.journal.beginAttempt(NOW+160000)!,feed(),NOW+160000);
 const after=JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_batches WHERE attempt=?').get(NOW+160000)!.body));
 expect(after.quality.collectorInterruptions.details[0]).toMatchObject({attemptAt:NOW+155000,contextUnknown:true});
 expect(after.quality.collectorInterruptions.details[0]).not.toHaveProperty('contextKey');
});
