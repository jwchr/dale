import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createEarlierDomain, parseEarlierAnswer, parseEarlierQuery, type EarlierQuery, type EarlierState } from '../../src/domain/earlierBuses';
import { EarlierBuses } from '../../worker/earlier-buses';
import { HistoryJournal, historyContextKey, type HistoryStorage } from '../../worker/history-journal';
import { createFeedClass, createRouter } from '../../worker/service';
import { liveDataset as ds, NOW } from '../helpers/liveBus';
import type { NormalizedFeed } from '../../worker/normalize';

const now = Date.parse('2026-11-04T13:00:00Z');
const at = (clock: string) => Date.parse(`2026-11-04T${clock}:00-05:00`);
const query: EarlierQuery = { route: '165', stop: '1', direction: 0 };
const fresh = (): EarlierState => ({ v: 1, context: 'ctx', checkpoint: now - 1, coverageStart: at('06:00'), through: now, gap: false, trips: {} });
const sample = (index: number, clock: string, id = 'T1@20261104') => ({ observation: { tripInstanceId: id, vehicleId: 'PRIVATE-VEHICLE', lat: 40.12345,
  lon: -74.54321, observedAt: at(clock), stopCall: { status: 'stopped_at', stopIndex: index, stopId: ds.patterns.find(p => p.id === ds.trips.find(t => t.id === id.split('@')[0])!.patternId)!.stopIds[index] } } });
const prediction = (clock = '07:46') => ({ tripInstanceId: 'T1@20261104', observedAt: at('07:10'), predictions: [
  { stopIndex: 2, at: at(clock), observedAt: at('07:10'), kind: 'arrival' as const }] });
const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
function harness(data = ds) {
  const db = new DatabaseSync(':memory:'); dbs.push(db); let fail = false, size = 4096;
  const storage: HistoryStorage = {
    sql: { get databaseSize() { return size; }, exec(q, ...b) {
      if (fail && q.startsWith('INSERT INTO dale_earlier_buses')) throw Error('synthetic crash');
      const rows = db.prepare(q).all(...b) as Record<string, unknown>[];
      return { toArray: () => rows };
    } },
    transactionSync<T>(cb: () => T): T { db.exec('BEGIN'); try { const out = cb(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
  new HistoryJournal(storage, data, 'ctx');
  const projection = new EarlierBuses(storage, data, 'ctx');
  const insert = (attempt: number, records: unknown[], context = 'ctx', extra = {}) => {
    const text = JSON.stringify({ records, ...extra });
    db.prepare('INSERT INTO dale_history_batches(attempt,received_at,feed_version,context_key,bytes,body) VALUES(?,?,?,?,?,?)')
      .run(attempt, attempt, ds.meta.feedVersion, context, text.length, text);
  };
  return { db, storage, projection, insert, databaseSize: (n: number) => { size = n; }, crash: (v: boolean) => { fail = v; } };
}

it('reports earliest official GPS sample and latest prediction separately; replay is idempotent and private', () => {
  const domain = createEarlierDomain(ds), state = fresh();
  const batch = { records: [sample(0, '07:03'), sample(0, '07:04'), sample(1, '07:23')], tripChanges: [prediction()] };
  domain.fold(state, batch, now); domain.fold(state, batch, now);
  let answer = domain.answer(state, query, now);
  expect(answer.items).toHaveLength(1);
  expect(answer.items[0]).toMatchObject({ stop: { scheduledAt: at('07:00'), evidence: { kind: 'gps', at: at('07:03'), minutesLate: 3 } },
    portAuthority: { scheduledAt: at('07:40'), evidence: { kind: 'prediction', at: at('07:46'), sourceAt: at('07:10'), minutesLate: 6 } } });
  domain.fold(state, { records: [sample(2, '07:43')] }, now);
  answer = domain.answer(state, query, now);
  expect(answer.items[0]!.portAuthority!.evidence).toMatchObject({ kind: 'gps', minutesLate: 3 });
  expect(parseEarlierAnswer(answer, query)).toEqual(answer);
  expect(JSON.stringify(answer)).not.toMatch(/PRIVATE|vehicle|tripInstance|T1@|lat|lon|context/);
});

it('never converts a missing stop call, future report, first sighting at the boarding stop, or wrong stop into departure', () => {
  const d = createEarlierDomain(ds), state = fresh();
  d.fold(state, { records: [sample(0, '07:03'), sample(1, '09:00'), { observation: { tripInstanceId: 'T1@20261104', observedAt: at('07:30') } },
    { observation: { ...sample(1, '07:24').observation, stopCall: { status: 'stopped_at', stopIndex: 1, stopId: 'wrong' } } }] }, now);
  expect(d.answer(state, query, now).items).toEqual([]);
  d.fold(state, { records: [sample(2, '07:45')] }, now);
  const unknown = d.answer(state, { ...query, stop: '2' }, now).items[0]!.stop;
  expect(unknown).toEqual({ scheduledAt: null, evidence: null }); // GTFS interpolated time is not official.
});

it('clears cancelled/skipped predictions without erasing GPS or inventing cancellation on missing feeds', () => {
  const d = createEarlierDomain(ds), state = fresh();
  d.fold(state, { records: [sample(0, '07:03'), sample(1, '07:23')], tripChanges: [prediction()] }, now);
  d.fold(state, { tripChanges: [{ ...prediction(), observedAt: at('07:09'), cancelled: true }] }, now);
  expect(d.answer(state, query, now).items[0]!.portAuthority!.evidence!.kind).toBe('prediction');
  d.fold(state, { tripChanges: [{ ...prediction(), cancelled: true }] }, now);
  expect(d.answer(state, query, now).items[0]!.portAuthority!.evidence).toBeNull();
  expect(d.answer(state, query, now).items[0]!.stop.evidence!.kind).toBe('gps');
});

it('includes previous service-day overnight trips in Eastern today, excludes yesterday, and filters route/direction', () => {
  const d = createEarlierDomain(ds), state = fresh();
  d.fold(state, { records: [sample(0, '00:13', 'T2@20261103'), sample(2, '01:03', 'T2@20261103')] }, now);
  expect(d.answer(state, query, now).items[0]!.stop).toMatchObject({ scheduledAt: at('00:10'), evidence: { minutesLate: 3 } });
  expect(d.answer(state, { ...query, direction: 1 }, now).items).toEqual([]);
  expect(d.answer(state, { ...query, route: '165T' }, now).items).toEqual([]);
});

it('validates query and answer strictly, including source clocks, duplicates and guessed delays', () => {
  const valid = 'route=165&stop=1&direction=0';
  expect(parseEarlierQuery(new URLSearchParams(valid), ds)).toEqual(query);
  for (const q of ['', valid + '&vehicle=x', valid + '&route=165', valid.replace('stop=1', 'stop=999'), valid.replace('direction=0', 'direction=2')])
    expect(parseEarlierQuery(new URLSearchParams(q), ds)).toBeUndefined();
  const d = createEarlierDomain(ds), state = fresh(); d.fold(state, { records: [sample(0, '07:03'), sample(2, '07:43')] }, now);
  const a = d.answer(state, query, now);
  a.items[0]!.stop.evidence!.minutesLate = 999;
  expect(parseEarlierAnswer(a, query)).toBeUndefined();
});

it('keeps checkpoint and answer unchanged after denied budget or crash, then replays without duplicate rows', () => {
  const h = harness();
  h.insert(at('07:03'), [sample(0, '07:03')]); h.insert(at('07:43'), [sample(2, '07:43')]);
  h.projection.fold(now, () => false); expect(h.projection.answer(query, now)).toBeUndefined();
  h.crash(true); h.projection.fold(now + 300_000, () => true); expect(h.projection.answer(query, now)).toBeUndefined();
  h.crash(false); const restarted = new EarlierBuses(h.storage, ds, 'ctx'); restarted.fold(now + 600_000, () => true);
  expect(restarted.answer(query, now + 600_000)!.items).toHaveLength(1);
  restarted.fold(now + 900_000, () => true);
  expect(restarted.answer(query, now + 900_000)!.items).toHaveLength(1);
  expect(new EarlierBuses(h.storage, ds, 'other-context').answer(query, now)).toBeUndefined();
});

it('folds a bounded page, persists through journal pruning, and exposes gaps without joining other schedules', () => {
  const h = harness();
  for (let i = 0; i < 30; i++) h.insert(at('07:03') + i * 30_000, [sample(0, '07:03')]);
  h.insert(at('07:43'), [sample(2, '07:43')], 'other');
  h.projection.fold(now, () => true);
  expect(h.projection.answer(query, now)!.through).toBe(at('07:03') + 23 * 30_000);
  h.projection.fold(now + 30_000, () => true);
  expect(h.projection.answer(query, now)!.gap).toBe(true);
  expect(h.projection.answer(query, now)!.items).toEqual([]);
  h.insert(at('07:44'), [sample(2, '07:43')]);
  h.projection.fold(now + 330_000, () => true);
  h.db.exec('DELETE FROM dale_history_batches');
  expect(h.projection.answer(query, now + 330_000)!.items).toHaveLength(1);
});

it('retains normalized predictions only when opted in; original journal transaction is unchanged', () => {
  const h = harness(), journal = new HistoryJournal(h.storage, ds, 'ctx', true);
  journal.setEnabled(true, NOW);
  const attempt = journal.beginAttempt(NOW)!;
  const feed: NormalizedFeed = { feed: { state: 'ok', timestamp: NOW }, observations: [], updates: [] };
  journal.complete(attempt, feed, NOW, { ...feed, updates: [{ ...prediction(), observedAt: NOW, predictions: prediction().predictions.map(p => ({ ...p, observedAt: NOW })), cancelled: false, skippedStops: [] }] });
  const body = JSON.parse(String(h.db.prepare('SELECT body FROM dale_history_batches').get()!.body));
  expect(body.tripChanges[0].predictions).toHaveLength(1);
  expect(body.tripChanges[0].predictions[0]).toMatchObject({ kind: 'arrival', observedAt: NOW });
});

it('router is off by default and refuses malformed input without forwarding', async () => {
  const router = createRouter(ds); let calls = 0;
  const env = { EARLIER_BUSES: 'public', FEED: { idFromName: () => 'one', get: () => ({ fetch: async () => { calls++; return Response.json({ state: 'unavailable' }, { status: 503 }); } }) } };
  const req = (q = 'route=165&stop=1&direction=0') => new Request(`https://worker.test/v1/earlier-buses?${q}`);
  expect((await router.fetch(req(), { ...env, EARLIER_BUSES: undefined } as never)).status).toBe(404);
  expect((await router.fetch(req('route=165'), env as never)).status).toBe(400);
  expect(calls).toBe(0);
  expect((await router.fetch(req(), env as never)).status).toBe(503); expect(calls).toBe(1);
});

it('Durable Object reads return projection only, without network calls or journal writes', async () => {
  const h = harness(), context = await historyContextKey(ds);
  h.insert(at('07:03'), [sample(0, '07:03')], context); h.insert(at('07:43'), [sample(2, '07:43')], context);
  new EarlierBuses(h.storage, ds, context).fold(now, () => true);
  const saved = new Map<string, unknown>(); let network = 0;
  const storage = { ...h.storage, get: async <T,>(k: string) => saved.get(k) as T | undefined, put: async (k: string, v: unknown) => { saved.set(k, v); },
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} };
  const Feed = createFeedClass(ds, (async () => { network++; throw Error('no network'); }) as typeof fetch, () => now);
  const object = new Feed({ storage, blockConcurrencyWhile: async <T,>(cb: () => Promise<T>) => cb() }, { EARLIER_BUSES: 'public' } as never);
  const response = await object.fetch(new Request('https://do.test/v1/earlier-buses?route=165&stop=1&direction=0'));
  expect(response.status).toBe(200); expect((await response.json() as { items: unknown[] }).items).toHaveLength(1);
  expect(network).toBe(0);
});

it('uses Eastern calendar today and GTFS noon anchor through both daylight-saving changes', () => {
  for (const [date, seconds, expected, source] of [
    ['20261101', 1 * 3600 + 30 * 60, '2026-11-01T06:30:00Z', '2026-11-01T06:33:00Z'],
    ['20270314', 3 * 3600 + 30 * 60, '2027-03-14T07:30:00Z', '2027-03-14T07:33:00Z'],
  ] as const) {
    const data = structuredClone(ds);
    for (const c of Object.values(data.calendars)) c.days = [true, true, true, true, true, true, true];
    const trip = data.trips.find(t => t.id === 'T1')!;
    trip.times = [seconds, seconds + 600, seconds + 2400]; trip.arrivals = [...trip.times];
    const d = createEarlierDomain(data), state = fresh(), stamp = Date.parse(source), testNow = stamp + 3600_000;
    const a = sample(0, '07:03', `T1@${date}`), b = sample(2, '07:43', `T1@${date}`);
    a.observation.observedAt = stamp; b.observation.observedAt = stamp + 2400_000;
    d.fold(state, { records: [a, b] }, testNow);
    expect(d.answer(state, query, testNow).items[0]!.stop).toMatchObject({ scheduledAt: Date.parse(expected), evidence: { minutesLate: 3 } });
  }
});

it('returns only the latest five exact scheduled trips', () => {
  const data = structuredClone(ds), original = data.trips.find(t => t.id === 'T1')!;
  data.trips.push(...Array.from({ length: 6 }, (_, i) => ({ ...original, id: `EXTRA${i}`, times: original.times.map(s => s + i * 60) })));
  const domain = createEarlierDomain(data), state = fresh();
  domain.fold(state, { records: data.trips.filter(t => t.id.startsWith('EXTRA')).flatMap(t => [0, 2].map(index => ({ observation: {
    tripInstanceId: `${t.id}@20261104`, observedAt: at(index === 0 ? '07:10' : '07:50'),
    stopCall: { status: 'stopped_at', stopIndex: index, stopId: index === 0 ? '1' : '3' },
  } }))) }, now);
  const answer = domain.answer(state, query, now);
  expect(answer.items).toHaveLength(5);
  expect(answer.items.map(i => i.stop.scheduledAt)).toEqual([5, 4, 3, 2, 1].map(i => at('07:00') + i * 60_000));
});

it('refuses storage and trip-count limits before reserving writes or moving the checkpoint', () => {
  const h = harness(); let reserves = 0;
  h.insert(at('07:03'), [sample(0, '07:03')]); h.insert(at('07:43'), [sample(2, '07:43')]);
  h.databaseSize(450_000_000);
  h.projection.fold(now, () => { reserves++; return true; });
  expect(reserves).toBe(0); expect(h.projection.answer(query, now)).toBeUndefined();
  h.databaseSize(4096); h.projection.fold(now + 300_000, () => { reserves++; return true; });
  expect(reserves).toBe(1); expect(h.projection.answer(query, now + 300_000)!.items).toHaveLength(1);
  const data = structuredClone(ds), t = data.trips.find(t => t.id === 'T1')!;
  data.trips = Array.from({ length: 2001 }, (_, i) => ({ ...t, id: `CAP${i}` }));
  const full = harness(data);
  for (let offset = 0; offset < 2001; offset += 100) {
    full.insert(at('07:03') + offset, data.trips.slice(offset, offset + 100).map(trip => ({ observation: {
      tripInstanceId: `${trip.id}@20261104`, observedAt: at('07:03'), stopCall: { status: 'stopped_at', stopIndex: 0, stopId: '1' },
    } })));
  }
  let beyondLimitReserves = 0;
  full.projection.fold(now, () => { beyondLimitReserves++; return true; });
  expect(beyondLimitReserves).toBe(0);
  expect(full.projection.answer(query, now)).toBeUndefined();
});
