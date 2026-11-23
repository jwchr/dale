import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createEarlierDomain, parseEarlierAnswer, parseEarlierQuery, type EarlierQuery, type EarlierState } from '../../src/domain/earlierBuses';
import { EarlierBuses, EARLIER_MAX_BYTES, EARLIER_MAX_TRIPS } from '../../worker/earlier-buses';
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

it('starts a new schedule at its own first batch, without claiming coverage from the old schedule', () => {
  const h = harness();
  h.insert(at('06:00'), [], 'old-context');
  h.insert(at('07:00'), [], 'old-context');
  h.projection.fold(now, () => true);
  expect(h.projection.answer(query, now)).toBeUndefined();
  h.insert(at('07:03'), [sample(0, '07:03')]);
  h.insert(at('07:03') + 30_000, [sample(1, '07:03')]);
  const restarted = new EarlierBuses(h.storage, ds, 'ctx');
  restarted.fold(now, () => true);
  expect(restarted.answer(query, now)).toMatchObject({ coverageStart: at('07:03'), gap: false, items: [{ route: '165' }] });
});

for (const extra of [{}, { omissionReason: 'synthetic' }, { quality: { feedState: 'unavailable' } }]) {
  it(`resets daily coverage and gaps at Eastern midnight, not UTC midnight (${JSON.stringify(extra)})`, () => {
    const h = harness(), first = Date.parse('2026-11-03T23:50:00-05:00');
    const interval = Object.keys(extra).length ? 30_000 : 60_000;
    h.insert(first, [], 'ctx', extra);
    h.insert(first + interval, []); // Isolate batch failures from the polling-gap trigger.
    h.projection.fold(first + interval, () => true);
    expect(h.projection.answer(query, first + interval)!.gap).toBe(true);
    const midnight = Date.parse('2026-11-04T00:00:00-05:00');
    expect(h.projection.answer(query, midnight)).toBeUndefined(); // Yesterday is never today's coverage.
    h.insert(midnight, []);
    h.insert(midnight + 30_000, []);
    h.projection.fold(midnight + 60_000, () => true);
    expect(h.projection.answer(query, midnight + 60_000)).toMatchObject({ coverageStart: midnight, through: midnight + 30_000, gap: false });
    // UTC's next date starts at 7 PM Eastern. It must not reset today's gap.
    const utcMidnight = Date.parse('2026-11-05T00:00:00Z');
    h.insert(utcMidnight, []);
    h.projection.fold(utcMidnight, () => true);
    expect(h.projection.answer(query, utcMidnight)).toMatchObject({ coverageStart: midnight, gap: true });
  });
}

for (const delayed of [false, true]) {
  it(`bypasses the five-minute throttle at Eastern midnight, with delayed batch: ${delayed}`, () => {
    const h = harness(), midnight = at('00:00');
    h.insert(midnight - 30_000, []);
    h.projection.fold(midnight - 30_000, () => true);
    expect(h.projection.answer(query, midnight - 30_000)).toBeDefined();
    if (delayed) {
      h.projection.fold(midnight, () => { throw Error('no batch needs no writes'); });
      expect(h.projection.answer(query, midnight)).toBeUndefined();
    }
    const first = midnight + (delayed ? 30_000 : 0);
    h.insert(first, []);
    h.projection.fold(first, () => true);
    expect(h.projection.answer(query, first)).toMatchObject({ coverageStart: first, through: first, gap: false });
    h.insert(first + 30_000, []);
    let reserves = 0;
    h.projection.fold(first + 30_000, () => { reserves++; return true; });
    expect(reserves).toBe(0);
    expect(h.projection.answer(query, first + 30_000)!.through).toBe(first);
  });
}

it('retries a denied midnight fold on the next collection tick without moving its checkpoint', () => {
  const h = harness(), midnight = at('00:00');
  h.insert(midnight - 30_000, []);
  h.projection.fold(midnight - 30_000, () => true);
  h.insert(midnight, []);
  let reserves = 0;
  h.projection.fold(midnight, () => { reserves++; return false; });
  expect(reserves).toBe(1);
  expect(h.projection.answer(query, midnight)).toBeUndefined();
  h.insert(midnight + 30_000, []);
  h.projection.fold(midnight + 30_000, () => true);
  expect(h.projection.answer(query, midnight + 30_000)).toMatchObject({ coverageStart: midnight, through: midnight + 30_000, gap: false });
});

it('retains overnight evidence while resetting the day, and preserves new-day failures across a crash and paged replay', () => {
  const h = harness(), midnight = at('00:00');
  h.insert(midnight - 30_000, []);
  h.projection.fold(midnight - 1, () => true);
  for (let i = 0; i < 28; i++) h.insert(midnight + i * 30_000, i === 26 ? [sample(0, '00:13', 'T2@20261103')] : [],
    'ctx', i === 0 ? { quality: { feedState: 'unavailable' } } : {});
  h.insert(at('01:03'), [sample(2, '01:03', 'T2@20261103')]);
  h.crash(true); h.projection.fold(now, () => true);
  expect(h.projection.answer(query, now)).toBeUndefined();
  h.crash(false);
  const restarted = new EarlierBuses(h.storage, ds, 'ctx');
  restarted.fold(now, () => true);
  expect(restarted.answer(query, now)).toMatchObject({ coverageStart: midnight, through: midnight + 23 * 30_000, gap: true });
  restarted.fold(now + 30_000, () => true);
  expect(restarted.answer(query, now)).toMatchObject({ coverageStart: midnight, gap: true,
    items: [{ stop: { scheduledAt: at('00:10'), evidence: { at: at('00:13') } } }] });
});

for (const [before, after] of [
  ['2026-03-08T01:59:30-05:00', '2026-03-08T03:00:00-04:00'],
  ['2026-11-01T01:59:30-04:00', '2026-11-01T01:00:00-05:00'],
]) it(`keeps continuous daily coverage through the DST change at ${after}`, () => {
  const h = harness(), a = Date.parse(before!), b = Date.parse(after!);
  h.insert(a, []); h.projection.fold(a, () => true);
  h.insert(b, []);
  new EarlierBuses(h.storage, ds, 'ctx').fold(b, () => true);
  expect(h.projection.answer(query, b)).toMatchObject({ coverageStart: a, through: b, gap: false });
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

it('refuses unsafe storage but advances an oversized trip page with an explicit gap', () => {
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
  expect(beyondLimitReserves).toBe(1);
  expect(full.projection.answer(query, now)).toMatchObject({ gap: true, through: at('07:03') + 2000, items: [] });
  const saved = JSON.parse(String(full.db.prepare('SELECT body FROM dale_earlier_buses').get()!.body));
  expect(saved.checkpoint).toBe(at('07:03') + 2000);
  expect(Object.keys(saved.trips).length).toBeLessThanOrEqual(2000);
  full.insert(at('07:43'), [], 'ctx');
  new EarlierBuses(full.storage, data, 'ctx').fold(now + 300000, () => true);
  expect(full.projection.answer(query, now + 300000)).toMatchObject({ gap: true, through: at('07:43') });
});


it('omits an oversized byte page atomically, retains prior evidence, then continues replay after restart', () => {
  const data = structuredClone(ds), trip = data.trips.find(t => t.id === 'T1')!;
  const pattern = data.patterns.find(p => p.id === trip.patternId)!;
  pattern.stopIds.push(...Array.from({ length: 15000 }, () => '1'));
  const h = harness(data);
  h.insert(at('07:03'), [sample(0, '07:03')]);
  h.projection.fold(now, () => true);
  const before = String(h.db.prepare('SELECT body FROM dale_earlier_buses').get()!.body);
  h.insert(at('07:04'), [], 'ctx', { tripChanges: [{ tripInstanceId: 'T1@20261104', observedAt: at('07:04'),
    predictions: pattern.stopIds.map((_, stopIndex) => ({ stopIndex, at: at('07:45'), observedAt: at('07:04'), kind: 'arrival' })) }] });
  h.projection.fold(now + 300000, () => false);
  expect(h.db.prepare('SELECT body FROM dale_earlier_buses').get()!.body).toBe(before);
  h.crash(true); new EarlierBuses(h.storage, data, 'ctx').fold(now + 300000, () => true);
  expect(h.db.prepare('SELECT body FROM dale_earlier_buses').get()!.body).toBe(before);
  h.crash(false); new EarlierBuses(h.storage, data, 'ctx').fold(now + 300000, () => true);
  const row = String(h.db.prepare('SELECT body FROM dale_earlier_buses').get()!.body), saved = JSON.parse(row);
  expect(saved).toMatchObject({ checkpoint: at('07:04'), through: at('07:04'), gap: true });
  expect(saved.trips).toEqual(JSON.parse(before).trips);
  expect(Buffer.byteLength(row)).toBeLessThanOrEqual(1000000);
  h.insert(at('07:43'), [sample(2, '07:43')]);
  new EarlierBuses(h.storage, data, 'ctx').fold(now + 600000, () => true);
  expect(h.projection.answer(query, now + 600000)).toMatchObject({ gap: true, through: at('07:43'),
    items: [{ stop: { evidence: { at: at('07:03') } } }] });
});

it('shares pure pruning with normal folding for stale, future, unknown and inactive service trips', () => {
  const domain = createEarlierDomain(ds), through = Date.parse('2026-11-05T00:00:00-05:00');
  const row = { gps: { 0: at('07:03') }, predictions: {} };
  const input = Object.fromEntries(['T1@20261103', 'T1@20261104', 'T2@20261104', 'T1@20261105',
    'T1@20261106', 'unknown@20261105', 'T1@invalid'].map(id => [id, structuredClone(row)]));
  const before = structuredClone(input), expected = {
    'T1@20261104': row, 'T2@20261104': row, 'T1@20261105': row,
  };
  expect(domain.prune(input, through)).toEqual(expected);
  expect(input).toEqual(before);
  const state = { ...fresh(), trips: structuredClone(input) };
  domain.fold(state, {}, through);
  expect(state.trips).toEqual(expected);
  // Thanksgiving explicitly removes WK service in the synthetic calendar.
  expect(domain.prune({ 'T1@20261126': row }, Date.parse('2026-11-26T12:00:00-05:00'))).toEqual({});
});

it.each(['trips', 'bytes'] as const)('prunes restored trips at advanced Eastern through after repeated %s overflows', limit => {
  const midnight = Date.parse('2026-11-05T00:00:00-05:00'), before = midnight - 30_000;
  const data = structuredClone(ds), trip = data.trips.find(t => t.id === 'T1')!;
  if (limit === 'trips') data.trips.push(...Array.from({ length: EARLIER_MAX_TRIPS + 1 }, (_, i) => ({ ...trip, id: `OVERFLOW${i}` })));
  const pattern = data.patterns.find(p => p.id === trip.patternId)!;
  if (limit === 'bytes') pattern.stopIds.push(...Array.from({ length: 15000 }, () => '1'));
  const h = harness(data);
  h.insert(before, [sample(0, '07:03', 'T1@20261103'), sample(0, '07:03')], 'ctx', { tripChanges: [{
    tripInstanceId: 'T2@20261104', observedAt: before,
    predictions: [{ stopIndex: 0, kind: 'departure', at: midnight + 13 * 60_000, observedAt: before }],
  }] });
  h.projection.fold(before, () => true);
  const read = () => JSON.parse(String(h.db.prepare('SELECT body FROM dale_earlier_buses').get()!.body)) as EarlierState;
  const initial = read();
  expect(Object.keys(initial.trips).sort()).toEqual(['T1@20261103', 'T1@20261104', 'T2@20261104']);
  const retained = { 'T1@20261104': initial.trips['T1@20261104'], 'T2@20261104': initial.trips['T2@20261104'] };
  // The first oversized page straddles midnight. Subsequent oversized pages must not resurrect old trips.
  h.insert(midnight - 15_000, []);
  for (const pageAt of [midnight, midnight + 300_000]) {
    const records = limit === 'trips' ? data.trips.filter(t => t.id.startsWith('OVERFLOW')).map(t => ({ observation: {
      tripInstanceId: `${t.id}@20261105`, observedAt: pageAt, stopCall: { status: 'stopped_at', stopIndex: 0, stopId: '1' },
    } })) : [];
    const tripChanges = limit === 'bytes' ? [{ tripInstanceId: 'T1@20261105', observedAt: pageAt,
      predictions: pattern.stopIds.map((_, stopIndex) => ({ stopIndex, kind: 'arrival', at: pageAt, observedAt: pageAt })) }] : [];
    h.insert(pageAt, records, 'ctx', { tripChanges });
    // Delayed replay must prune for through (Nov 5), not the processing clock (Nov 6).
    new EarlierBuses(h.storage, data, 'ctx').fold(pageAt + 86_400_000, () => true);
    const saved = read();
    expect(saved).toMatchObject({ checkpoint: pageAt, through: pageAt, coverageStart: midnight, gap: true });
    expect(saved.trips).toEqual(retained);
    expect(Object.keys(saved.trips).length).toBeLessThanOrEqual(EARLIER_MAX_TRIPS);
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(EARLIER_MAX_BYTES);
  }
});

it.each([NaN, -1, 450000000])('refuses unsafe database size %s without checkpoint or reservation', size => {
  const h = harness(); h.insert(at('07:03'), []); h.databaseSize(size);
  let reserves = 0; h.projection.fold(now, () => { reserves++; return true; });
  expect(reserves).toBe(0);
  expect(h.db.prepare('SELECT body FROM dale_earlier_buses').get()).toBeUndefined();
});
