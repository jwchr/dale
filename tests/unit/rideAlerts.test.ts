// Locked-phone stop alerts (#176 step C), Worker half. Design: docs/LOCKED_STOP_ALERTS.md.
// Synthetic keys and household code are generated here at runtime; nothing secret is committed.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFeedClass, createRouter } from '../../worker/service';
import {
  allowedEndpoint, codeMatches, createRideRules, decideRide, WrongCodes, MAX_PUSH_FAILURES, MAX_RIDES, NOTICE_REPUSHES, RIDE_CAP_MS, SAVE_MS, type RideRow,
} from '../../worker/ride-alerts';
import { HistoryArchive } from '../../worker/history-archive';
import { HistoryJournal } from '../../worker/history-journal';
import { fromBase64Url, loadVapid, sendPush, toBase64Url, PUSH_TTL_SECONDS, VAPID_SUBJECT } from '../../worker/web-push';
import { liveDataset, NOW, binaryFeed, descriptor } from '../helpers/liveBus';
import { createBusSession, reduceBusSession, type BusSession } from '../../src/domain/busLock';
import { rideGuide } from '../../src/domain/rideGuide';
import { departuresOn } from '../../src/domain/schedule';
import { stageMessage } from '../../src/domain/stopAlert';
import { strings } from '../../src/ui/i18n';
import type { Dataset } from '../../src/domain/types';
import type { LiveBusSnapshot } from '../../src/domain/liveBus';

// Seven stops about 660 m apart on a straight synthetic line, so every countdown stage can occur.
const ds: Dataset = structuredClone(liveDataset);
const LINE = Array.from({ length: 7 }, (_, i) => ({ id: `L${i}`, name: `LINE STOP ${i}`, lat: 40.9 - 0.006 * i, lon: -74.05 }));
ds.stops.push(...LINE);
{
  const trip = ds.trips.find((t) => t.id === 'T1')!, base = ds.patterns.find((p) => p.id === trip.patternId)!;
  ds.patterns.push({ id: 'P-line', routeId: base.routeId, directionId: base.directionId, headsign: base.headsign, stopIds: LINE.map((s) => s.id) });
  trip.patternId = 'P-line'; trip.times = LINE.map((_, i) => 7 * 3600 + i * 300); trip.arrivals = [...trip.times]; delete trip.estimated;
}
const ORIGIN = 'https://jwchr.github.io', BASE = 'https://dale-live.test.workers.dev', INSTANCE = 'T1@20261104';
const CODE = 'ABCD-EFGH JKLM-NPQR';
const at = (stop: number, lonShift = 0) => ({ latitude: 40.9 - 0.006 * stop, longitude: -74.05 + lonShift });
const hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((n) => n.toString(16).padStart(2, '0')).join('');
async function secrets() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { VAPID_PRIVATE_KEY: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }), HOUSEHOLD_CODE_HASH: await hex('ABCDEFGHJKLMNPQR'), publicKey: toBase64Url(raw) };
}

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

interface FeedState { stop: number | null; lonShift: number; age: number; vehicleId: string; second?: number; skipped: string[]; prediction?: { stopId: string; at: number; age?: number } }
async function harness(options: { collection?: boolean; archive?: boolean; keys?: Partial<Awaited<ReturnType<typeof secrets>>> | null; sql?: boolean } = {}) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  let now = NOW, alarmAt: number | null = null, full = false, rideWrites = 0;
  const saved = new Map<string, unknown>(), calls: { endpoint: string; at: number }[] = [], pushes: { url: string; headers: Headers; bytes: number; at: number }[] = [];
  let pushStatus: number | 'offline' = 201;
  const feed: FeedState = { stop: 0, lonShift: 0, age: 1, vehicleId: 'bus-A', skipped: [] };
  const storage = {
    ...(options.sql === false ? {} : {
      sql: { get databaseSize() { return full ? 500_000_000 : Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size); }, exec(query: string, ...bindings: (string | number | null)[]) {
        const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
        if (/^\s*(INSERT|UPDATE|DELETE)\b[^]*\bdale_ride_alerts\b/i.test(query)) rideWrites += Number(db.prepare('SELECT changes() AS n').get()!.n);
        return { toArray: () => rows };
      } },
      transactionSync<T>(callback: () => T): T {
        db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    }),
    get: async <T,>(key: string) => structuredClone(saved.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => { saved.set(key, structuredClone(value)); },
    getAlarm: async () => alarmAt,
    setAlarm: async (value: number) => { alarmAt = value; },
    deleteAlarm: async () => { alarmAt = null; },
  };
  const net = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://pcsdata.njtransit.com/')) {
      const body = init?.body instanceof Uint8Array ? init.body.byteLength : init?.body == null ? 0 : -1;
      pushes.push({ url, headers: new Headers(init?.headers), bytes: body, at: now });
      if (pushStatus === 'offline') throw new TypeError('network');
      return new Response(null, { status: pushStatus });
    }
    const endpoint = url.split('/').pop()!; calls.push({ endpoint, at: now });
    if (endpoint === 'authenticateUser') return Response.json({ Authenticated: 'True', UserToken: 'private-synthetic-token' });
    const seconds = Math.floor(now / 1000);
    if (endpoint === 'getVehiclePositions') {
      const entity = [];
      if (feed.stop !== null) entity.push({ id: 'v', vehicle: { trip: descriptor, vehicle: { id: feed.vehicleId }, timestamp: seconds - feed.age, position: at(feed.stop, feed.lonShift) } });
      if (feed.second !== undefined) entity.push({ id: 'w', vehicle: { trip: descriptor, vehicle: { id: 'bus-B' }, timestamp: seconds - 1, position: at(feed.second) } });
      return new Response(new Uint8Array(binaryFeed(entity, { timestamp: seconds - 1 })).buffer);
    }
    const stops = [...feed.skipped.map((stopId) => ({ stopId, scheduleRelationship: 1 })),
      ...(feed.prediction ? [{ stopId: feed.prediction.stopId, arrival: { time: Math.floor(feed.prediction.at / 1000) } }] : [])];
    return new Response(new Uint8Array(binaryFeed([{ id: 'u', tripUpdate: { trip: descriptor, timestamp: seconds - (feed.prediction?.age ?? 1), stopTimeUpdate: stops } }], { timestamp: seconds - 1 })).buffer);
  }) as typeof fetch;
  const keys = options.keys === null ? {} : options.keys ?? await secrets();
  const ctx = { storage, blockConcurrencyWhile: async <T,>(callback: () => Promise<T>) => callback() };
  const Feed = createFeedClass(ds, net, () => now);
  const env = { NJT_API_USERNAME: 'synthetic', NJT_API_PASSWORD: 'synthetic', HISTORY_COLLECTION: options.collection ? 'enabled' : 'disabled',
    VAPID_PRIVATE_KEY: keys.VAPID_PRIVATE_KEY, HOUSEHOLD_CODE_HASH: keys.HOUSEHOLD_CODE_HASH, FEED: { idFromName: () => 'one', get: () => h.object },
    ...(options.archive ? { HISTORY_ARCHIVE: {} as never } : {}) };
  const router = createRouter(ds);
  const h = {
    object: new Feed(ctx, env), Feed, ctx, env, db, calls, pushes, feed, keys,
    now: () => now, clock: (value: number) => { now = value; }, advance: (ms: number) => { now += ms; },
    alarmAt: () => alarmAt,
    /** Ride rows written (inserted, updated or deleted), as the Free plan counts rows written. */
    rideWrites: () => rideWrites,
    /** Makes storage report the history size limit, as in the collector's storage-limit state. */
    setFull: (value: boolean) => { full = value; },
    setPush: (status: number | 'offline') => { pushStatus = status; },
    restart: () => { h.object = new Feed(ctx, env); },
    alarm: async () => { alarmAt = null; await h.object.alarm(); },
    api: (path: string, init: RequestInit = {}) => router.fetch(new Request(BASE + path, init), env),
    post: (path: string, body: unknown, ip = '203.0.113.7') => h.api(path, { method: 'POST', body: JSON.stringify(body),
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': ip } }),
    create: async (patch: Record<string, unknown> = {}, ip?: string) => {
      const response = await h.post('/v1/ride-alerts', { v: 1, code: CODE, endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-ride', trip: 'T1', date: '20261104',
        vehicle: 'bus-A', board: 0, alight: 5, lang: 'en', ...patch }, ip);
      return { status: response.status, body: await response.json() };
    },
    start: async (patch: Record<string, unknown> = {}) => {
      const made = await h.create(patch); expect(made.status).toBe(201);
      expect((await h.post(`/v1/ride-alerts/${made.body.id}/activate`, {})).status).toBe(200);
      return made.body.id as string;
    },
    latest: async (id: string) => { const r = await h.api(`/v1/ride-alerts/${id}/latest`); return { status: r.status, body: await r.json() }; },
    /** Moves the bus, lets the global pace allow a poll, and runs the alarm. */
    step: async (stop: number | null, ms = 30_000) => { h.feed.stop = stop; h.advance(ms); await h.alarm(); },
    health: async () => (await (await h.api('/v1/status')).json()),
  };
  return h;
}
type Harness = Awaited<ReturnType<typeof harness>>;
const pushCount = (h: Harness) => h.pushes.length;

describe('ride alert routes', () => {
  it('serves the derived public key, and answers "not available" when either secret is missing or malformed', async () => {
    const h = await harness();
    expect(await (await h.api('/v1/ride-alerts/config')).json()).toEqual({ v: 1, available: true, publicKey: h.keys.publicKey });
    for (const keys of [null, { HOUSEHOLD_CODE_HASH: 'f'.repeat(64) }, { VAPID_PRIVATE_KEY: (await secrets()).VAPID_PRIVATE_KEY }, { VAPID_PRIVATE_KEY: '{"kty":"EC"}', HOUSEHOLD_CODE_HASH: 'f'.repeat(64) },
      { ...(await secrets()), HOUSEHOLD_CODE_HASH: 'NOT-A-HASH' }]) {
      const off = await harness({ keys });
      const config = await off.api('/v1/ride-alerts/config');
      expect(config.status).toBe(200); expect(await config.json()).toEqual({ v: 1, available: false });
      const created = await off.create(); expect(created).toEqual({ status: 503, body: { v: 1, available: false } });
      const id = 'A'.repeat(22);
      expect((await off.api(`/v1/ride-alerts/${id}/latest`)).status).toBe(503);
      expect((await off.post(`/v1/ride-alerts/${id}/activate`, {})).status).toBe(503);
      expect((await off.api(`/v1/ride-alerts/${id}`, { method: 'DELETE', headers: { origin: ORIGIN } })).status).toBe(503);
    }
    // Without SQLite storage the routes are also unavailable rather than failing open.
    const noSql = await harness({ sql: false });
    expect((await noSql.create()).status).toBe(503);
  });

  it('applies the router rules: preflight, required Origin on writes, JSON only, size limit, id shape and methods', async () => {
    const h = await harness();
    const options = await h.api('/v1/ride-alerts', { method: 'OPTIONS', headers: { origin: ORIGIN } });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE');
    expect(options.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(options.headers.get('access-control-max-age')).toBe('600');
    const body = JSON.stringify({ v: 1 });
    expect((await h.api('/v1/ride-alerts', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status).toBe(403);
    expect((await h.api('/v1/ride-alerts', { method: 'POST', body, headers: { origin: 'https://evil.example', 'content-type': 'application/json' } })).status).toBe(403);
    expect((await h.api('/v1/ride-alerts', { method: 'POST', body, headers: { origin: ORIGIN, 'content-type': 'text/plain' } })).status).toBe(400);
    expect((await h.api('/v1/ride-alerts', { method: 'POST', body: '{', headers: { origin: ORIGIN, 'content-type': 'application/json' } })).status).toBe(400);
    expect((await h.api('/v1/ride-alerts', { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(5000) }), headers: { origin: ORIGIN, 'content-type': 'application/json' } })).status).toBe(413);
    expect((await h.api('/v1/ride-alerts', { method: 'DELETE', headers: { origin: ORIGIN } })).status).toBe(405);
    expect((await h.api('/v1/ride-alerts/short/latest')).status).toBe(404);
    expect((await h.api(`/v1/ride-alerts/${'A'.repeat(22)}/other`)).status).toBe(404);
    expect((await h.api(`/v1/ride-alerts/${'A'.repeat(22)}/latest`, { method: 'POST', headers: { origin: ORIGIN } })).status).toBe(405);
    expect((await h.api(`/v1/ride-alerts/${'A'.repeat(22)}`, { method: 'DELETE' })).status).toBe(403);
    const unknown = await h.latest('A'.repeat(22)); expect(unknown.status).toBe(404);
    // A well-formed unknown id deletes as a no-op; existing read routes keep their old rules.
    const deleted = await h.api(`/v1/ride-alerts/${'A'.repeat(22)}`, { method: 'DELETE', headers: { origin: ORIGIN } });
    expect(deleted.status).toBe(204); expect(deleted.headers.get('cache-control')).toBe('no-store');
    expect((await h.api('/v1/live?trip=T1&date=20261104', { method: 'POST' })).status).toBe(405);
    expect(h.calls).toEqual([]);
  });

  it('checks the household code in constant time and locks out an address after 5 wrong codes, never a correct code', async () => {
    expect(await codeMatches(' abcd-efgh jklm-npqr ', await hex('ABCDEFGHJKLMNPQR'))).toBe(true);
    expect(await codeMatches('ABCDEFGHJKLMNPQS', await hex('ABCDEFGHJKLMNPQR'))).toBe(false);
    expect(await codeMatches(42, await hex(''))).toBe(false);
    const h = await harness();
    for (let i = 0; i < 5; i++) expect(await h.create({ code: 'WRONG-CODE-' + i }, '198.51.100.1')).toEqual({ status: 401, body: { v: 1, error: 'code' } });
    expect(await h.create({ code: 'WRONG' }, '198.51.100.1')).toEqual({ status: 429, body: { v: 1, error: 'later' } });
    expect((await h.create({ code: 'WRONG' }, '198.51.100.2')).status).toBe(401);
    expect((await h.create({}, '198.51.100.1')).status).toBe(201);
    // Nothing was stored for the wrong codes.
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM dale_ride_alerts").get()!.n).toBe(1);
    h.advance(3600_000 + 1);
    expect((await h.create({ code: 'WRONG' }, '198.51.100.1')).status).toBe(401);
    const limiter = new WrongCodes();
    for (let i = 0; i < 4; i++) limiter.record('a', i * 200_000);
    expect(limiter.locked('a', 800_000)).toBe(false);
  });

  it('accepts only exact known push service hosts', async () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/abc:def', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/QGx',
      'https://api.push.apple.com/x', 'https://wns2-by3p.notify.windows.com/w/?token=abc']) expect(allowedEndpoint(ok), ok).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/fcm/send/a', 'https://fcm.googleapis.com:8443/a', 'https://user:pw@fcm.googleapis.com/a', 'https://evil.example/a',
      'https://fcm.googleapis.com.evil.example/a', 'https://push.apple.com.evil.example/a', 'https://notify.windows.com/a', 'https://evilpush.apple.com/a',
      'https://fcm.googleapis.com./a', 'https://127.0.0.1/a', ' https://fcm.googleapis.com/a', 'https://fcm.googleapis.com/' + 'a'.repeat(1024), 42, undefined]) {
      expect(allowedEndpoint(bad), String(bad)).toBe(false);
    }
    const h = await harness();
    expect(await h.create({ endpoint: 'https://evil.example/push' })).toEqual({ status: 400, body: { v: 1, error: 'invalid' } });
  });

  it.each([
    ['unknown trip', { trip: 'nope' }], ['inactive date', { date: '20261107' }], ['date neither today nor yesterday', { date: '20261102' }],
    ['malformed date', { date: '2026-11-04' }], ['bad vehicle', { vehicle: '' }], ['board after alight', { board: 4, alight: 2 }],
    ['alight past the trip', { alight: 7 }], ['fractional index', { board: 0.5 }], ['negative index', { board: -1 }], ['language', { lang: 'fr' }], ['version', { v: 2 }],
  ])('rejects %s', async (_, patch) => {
    const h = await harness();
    expect((await h.create(patch)).status).toBe(400);
  });

  it('accepts yesterday\'s service date for a late trip', async () => {
    const h = await harness();
    expect((await h.create({ date: '20261103' })).status).toBe(201);
  });

  it('caps rides at 20 in all, and a new ride for the same push subscription replaces the old one', async () => {
    const h = await harness();
    const ids: string[] = [];
    for (let i = 0; i < MAX_RIDES; i++) {
      const made = await h.create({ endpoint: `https://fcm.googleapis.com/fcm/send/ride-${i}` });
      expect(made.status).toBe(201); expect(made.body.id).toMatch(/^[A-Za-z0-9_-]{22}$/); ids.push(made.body.id);
    }
    expect(new Set(ids).size).toBe(MAX_RIDES);
    expect(await h.create({ endpoint: 'https://fcm.googleapis.com/fcm/send/ride-new' })).toEqual({ status: 429, body: { v: 1, error: 'full' } });
    const replacement = await h.create({ endpoint: 'https://fcm.googleapis.com/fcm/send/ride-3' });
    expect(replacement.status).toBe(201);
    expect(await h.latest(ids[3]!)).toEqual({ status: 410, body: { v: 1, kind: 'ended', reason: 'replaced' } });
    // The tombstone keeps no push address, trip, vehicle or stops.
    expect(h.db.prepare('SELECT endpoint, trip, vehicle, board, alight, session FROM dale_ride_alerts WHERE id=?').get(ids[3]!)).toEqual({ endpoint: null, trip: null, vehicle: null, board: null, alight: null, session: null });
    expect((await h.create({ endpoint: 'https://fcm.googleapis.com/fcm/send/ride-new' })).status).toBe(429);
  });
});

describe('ride checks', () => {
  it('sends nothing until activated, and deletes a ride not activated within 2 minutes', async () => {
    const h = await harness();
    const made = await h.create(); expect(made.status).toBe(201);
    expect(made.body.expiresAt).toBeGreaterThan(h.now());
    h.feed.stop = 3;
    // Pending only: the alarm exists for cleanup, but nothing polls NJ Transit or pushes.
    expect(h.alarmAt()).toBe(NOW + 120_000);
    h.clock(NOW + 60_000); await h.alarm();
    expect(h.calls).toEqual([]); expect(h.pushes).toEqual([]);
    h.clock(NOW + 120_000); await h.alarm();
    expect(await (await h.post(`/v1/ride-alerts/${made.body.id}/activate`, {})).json()).toEqual({ v: 1, kind: 'ended', reason: 'expired' });
    expect(h.alarmAt()).toBeNull();
    expect(h.pushes).toEqual([]);
  });

  it('runs on its own alarm with collection off, no faster than the global pace, and stops when no ride remains', async () => {
    const h = await harness();
    expect(h.alarmAt()).toBeNull();
    const id = await h.start();
    expect(h.alarmAt()).toBe(NOW + 1000);
    for (let i = 0; i < 6; i++) { h.advance(10_000); if (h.alarmAt()! <= h.now()) await h.alarm(); }
    const polls = h.calls.filter((c) => c.endpoint === 'getVehiclePositions').map((c) => c.at);
    expect(polls.length).toBeGreaterThan(1);
    for (let i = 1; i < polls.length; i++) expect(polls[i]! - polls[i - 1]!).toBeGreaterThanOrEqual(30_000);
    // A demand read in between shares the same pace.
    await h.api('/v1/live?trip=T1&date=20261104');
    expect(h.calls.filter((c) => c.endpoint === 'getVehiclePositions').length).toBe(polls.length);
    expect((await h.api(`/v1/ride-alerts/${id}?reason=got_off`, { method: 'DELETE', headers: { origin: ORIGIN } })).status).toBe(204);
    expect(h.alarmAt()).toBeNull();
    expect(await h.latest(id)).toEqual({ status: 410, body: { v: 1, kind: 'ended', reason: 'got_off' } });
    const before = h.calls.length; h.advance(60_000); await h.alarm(); expect(h.calls.length).toBe(before);
    // A restart with no ride left keeps the alarm off.
    h.restart(); await h.health(); expect(h.alarmAt()).toBeNull();
  });

  it('matches the app\'s stage for the same positions, through stale, off-route, ambiguous and skipped-stop cases', async () => {
    const h = await harness();
    const id = await h.start();
    const dep = departuresOn(ds, { stopId: 'L0', date: '20261104' }).find((d) => d.tripId === 'T1')!;
    let app: BusSession = createBusSession(dep, NOW - 60_000);
    const steps: { stop: number | null; lonShift?: number; age?: number; second?: number; skipped?: string[] }[] = [
      { stop: 0 }, { stop: 1 }, { stop: 1, age: 150 }, { stop: 2 }, { stop: 2.2, lonShift: 0.008 }, { stop: 2.5 }, { stop: 3 }, { stop: 3.3, second: 3.2 }, { stop: 3.6 },
      { stop: 4 }, { stop: 4.5 }, { stop: null }, { stop: 4.6 }, { stop: 4.6, skipped: ['L6'] }, { stop: 4.7 },
    ];
    const seen: string[] = [];
    for (const s of steps) {
      Object.assign(h.feed, { lonShift: s.lonShift ?? 0, age: s.age ?? 1, second: s.second, skipped: s.skipped ?? [] });
      await h.step(s.stop);
      const now = h.now();
      // The phone's own path for the same report (useLiveBus → busLock → RideMode).
      const fresh = s.stop !== null && (s.age ?? 1) * 1000 <= 120_000;
      const ambiguous = s.second !== undefined;
      app = reduceBusSession(app, { type: 'feed_status', tripInstanceId: INSTANCE, state: ambiguous ? 'ambiguous' : fresh ? 'ok' : 'missing', now });
      if (fresh && !ambiguous) {
        const p = at(s.stop!, s.lonShift ?? 0);
        app = reduceBusSession(app, { type: 'observation', source: 'official', receivedAt: now, obs: { tripInstanceId: INSTANCE, vehicleId: 'bus-A', observedAt: now - (s.age ?? 1) * 1000, lat: p.latitude, lon: p.longitude } });
      }
      if (s.skipped?.length) app = reduceBusSession(app, { type: 'official_skips', tripInstanceId: INSTANCE, indices: [6], observedAt: now - 1000, now });
      const expected = app.stopChanges?.indices.length ? 'service_change' : (() => { const g = rideGuide(ds, dep.pattern.stopIds, 0, 5, app.lock, now, app.history); return g.basis === 'gps' ? g.stage : 'uncertain'; })();
      const server = await h.latest(id);
      expect(server.status).toBe(200);
      const actual = server.body.kind === 'stage' ? server.body.stage : server.body.kind;
      expect(actual, JSON.stringify(s)).toBe(expected);
      seen.push(actual);
    }
    expect(seen).toEqual(['riding', 'riding', 'uncertain', 'three', 'uncertain', 'three', 'two', 'uncertain', 'two', 'one', 'request', 'uncertain', 'request', 'service_change', 'service_change']);
  });

  it('builds the stage line in the ride\'s language from the app\'s own strings', async () => {
    const h = await harness();
    const id = await h.start({ lang: 'es' });
    await h.step(3);
    const answer = await h.latest(id);
    expect(answer.body).toEqual({ v: 1, kind: 'stage', stage: 'two', rank: 2, stopsAway: 2, observedAt: h.now() - 1000, receivedAt: h.now(),
      title: strings.es.ride.notifyTitle, body: stageMessage(strings.es.ride, 'two', 2, 'LINE STOP 5') });
    await h.step(null, 150_000);
    expect((await h.latest(id)).body).toEqual({ v: 1, kind: 'uncertain', title: strings.es.ride.notifyTitle, body: strings.es.ride.lockedPush.cantCheck });
    expect(strings.en.ride.lockedPush.cantCheck).toBe('Dale can’t check your bus right now. Open Dale.');
  });

  it('alerts once for a ride registered inside 3 stops, re-pushes an unconfirmed stage while current, and never replays a passed one', async () => {
    const h = await harness();
    h.feed.stop = 3;
    const id = await h.start();
    await h.step(3);
    expect(pushCount(h)).toBe(1);
    // Lost answer: pushed again while still current, at most every 30 seconds.
    h.advance(10_000); await h.alarm(); expect(pushCount(h)).toBe(1);
    await h.step(3); expect(pushCount(h)).toBe(2);
    expect((await h.post(`/v1/ride-alerts/${id}/ack`, { stage: 'two' })).status).toBe(200);
    expect((await h.post(`/v1/ride-alerts/${id}/ack`, { stage: 'two' })).status).toBe(200);
    await h.step(3); expect(pushCount(h)).toBe(2);
    // Lower acks never lower "last shown".
    expect((await h.post(`/v1/ride-alerts/${id}/ack`, { stage: 'three' })).status).toBe(200);
    await h.step(3); expect(pushCount(h)).toBe(2);
    expect((await h.post(`/v1/ride-alerts/${id}/ack`, { stage: 'bogus' })).status).toBe(400);
    // Next stage: one push, then ("one" sent, not acknowledged) the bus moves on to "ask now".
    await h.step(4); expect(pushCount(h)).toBe(3);
    await h.step(4.5); expect(pushCount(h)).toBe(4);
    const row = h.db.prepare('SELECT sent_stage, shown FROM dale_ride_alerts WHERE id=?').get(id);
    expect(row).toEqual({ sent_stage: 'request', shown: 2 });
    // Jitter back to "one" never replays it, and arrival ends the ride.
    await h.step(4.05); expect(pushCount(h)).toBe(4);
    await h.step(5); expect(pushCount(h)).toBe(4);
    expect(await h.latest(id)).toEqual({ status: 410, body: { v: 1, kind: 'ended', reason: 'arrived' } });
    for (const push of h.pushes) expect(push.headers.get('topic')).toBe(id);
  });

  it('decides with stopAlertStep from rank 0, re-pushes only the current stage and never a lower one', () => {
    const base = { shown: 0, sentStage: null, lastPushAt: null, notice: 'none' as const, noticePushes: 0, noticeAt: null };
    const stage = (s: 'riding' | 'three' | 'two' | 'one' | 'request' | 'arrived' | 'passed') => ({ kind: 'stage' as const, stage: s, stopsAway: 1, observedAt: 0 });
    expect(decideRide(base, 0, stage('riding'))).toBeUndefined();
    expect(decideRide(base, 0, stage('two'))).toEqual({ push: 'stage', stage: 'two' });
    expect(decideRide({ ...base, sentStage: 'two', lastPushAt: 0 }, 29_999, stage('two'))).toBeUndefined();
    expect(decideRide({ ...base, sentStage: 'two', lastPushAt: 0 }, 30_000, stage('two'))).toEqual({ push: 'stage', stage: 'two' });
    expect(decideRide({ ...base, sentStage: 'two', lastPushAt: 0 }, 60_000, stage('three'))).toBeUndefined();
    expect(decideRide({ ...base, shown: 2, sentStage: 'two', lastPushAt: 0 }, 60_000, stage('two'))).toBeUndefined();
    expect(decideRide({ ...base, sentStage: 'two', lastPushAt: 0 }, 1, stage('one'))).toEqual({ push: 'stage', stage: 'one' });
    expect(decideRide(base, 0, stage('passed'))).toEqual({ end: 'passed' });
    expect(decideRide(base, 0, { kind: 'uncertain' })).toBeUndefined();
    expect(decideRide(base, 0, { kind: 'service_change' })).toEqual({ push: 'notice' });
    expect(decideRide({ ...base, sentStage: 'two', notice: 'shown' }, 0, { kind: 'service_change' })).toBeUndefined();
  });

  it('sends then records: a failed push is retried while current, a restart keeps the unconfirmed stage, and 404/410 ends the ride', async () => {
    const h = await harness();
    const id = await h.start();
    h.setPush(500); await h.step(2); expect(pushCount(h)).toBe(1);
    h.setPush('offline'); await h.step(2); expect(pushCount(h)).toBe(2);
    h.setPush(429); await h.step(2); expect(pushCount(h)).toBe(3);
    h.setPush(201); h.restart(); await h.step(2); expect(pushCount(h)).toBe(4);
    expect(h.db.prepare('SELECT sent_stage, shown FROM dale_ride_alerts WHERE id=?').get(id)).toEqual({ sent_stage: 'three', shown: 0 });
    // The restarted object gives the same answer from its stored lock and history.
    expect((await h.latest(id)).body.stage).toBe('three');
    for (const status of [404, 410]) {
      const other = await harness();
      const ride = await other.start();
      other.setPush(status); await other.step(2);
      expect(await other.latest(ride)).toEqual({ status: 410, body: { v: 1, kind: 'ended', reason: 'unlocked' } });
      expect(other.db.prepare('SELECT endpoint FROM dale_ride_alerts WHERE id=?').get(ride)).toEqual({ endpoint: null });
    }
  });

  it('records a stage as sent only when the push service accepted it, and ends the ride after 3 refusals in a row', async () => {
    const h = await harness();
    const id = await h.start();
    const row = () => h.db.prepare('SELECT sent_stage, last_push_at, failures FROM dale_ride_alerts WHERE id=?').get(id);
    // Refused (403, as after a key change): nothing is recorded as sent, and it stays due.
    h.setPush(403); await h.step(2);
    expect(pushCount(h)).toBe(1); expect(row()).toEqual({ sent_stage: null, last_push_at: null, failures: 1 });
    // Retried at most every 30 seconds.
    h.advance(10_000); await h.alarm(); expect(pushCount(h)).toBe(1);
    await h.step(2); expect(pushCount(h)).toBe(2); expect(row()).toMatchObject({ sent_stage: null, failures: 2 });
    // Network errors, 429 and 5xx are retried too, but do not count toward ending the ride.
    h.setPush(503); for (let i = 0; i < 4; i++) await h.step(2);
    expect(pushCount(h)).toBe(6); expect(row()).toMatchObject({ sent_stage: null, failures: 2 });
    // Accepted: now recorded as sent, and the count of refusals starts again.
    h.setPush(201); await h.step(2);
    expect(pushCount(h)).toBe(7); expect(row()).toMatchObject({ sent_stage: 'three', failures: 0 });
    h.setPush(403);
    for (let i = 0; i < MAX_PUSH_FAILURES; i++) await h.step(2);
    expect(pushCount(h)).toBe(7 + MAX_PUSH_FAILURES);
    expect(await h.latest(id)).toEqual({ status: 410, body: { v: 1, kind: 'ended', reason: 'push_failed' } });
    expect(h.db.prepare('SELECT endpoint, session FROM dale_ride_alerts WHERE id=?').get(id)).toEqual({ endpoint: null, session: null });
    await h.step(2); expect(pushCount(h)).toBe(7 + MAX_PUSH_FAILURES);
  });

  it('counts only accepted pushes toward the service-change notice limit', async () => {
    const h = await harness();
    const id = await h.start();
    h.feed.skipped = ['L6']; h.setPush(503);
    for (let i = 0; i < 8; i++) await h.step(2);
    // Every check tries again (every 30 seconds) and none of them uses up the limit.
    expect(pushCount(h)).toBe(8);
    expect(h.db.prepare('SELECT notice, notice_pushes FROM dale_ride_alerts WHERE id=?').get(id)).toEqual({ notice: 'none', notice_pushes: 0 });
    h.setPush(201);
    for (let i = 0; i < 40; i++) await h.step(2);
    expect(pushCount(h)).toBe(8 + 1 + NOTICE_REPUSHES);
    expect(h.db.prepare('SELECT notice, notice_pushes FROM dale_ride_alerts WHERE id=?').get(id)).toEqual({ notice: 'pending', notice_pushes: 1 + NOTICE_REPUSHES });
  });

  it('writes a ride at most every 2 minutes over an hour of fresh positions, and a sent stage at once', async () => {
    const h = await harness();
    const id = await h.start();
    const before = h.rideWrites();
    // An hour of fresh positions every 30 seconds, the bus creeping along (and running late) short of 3 stops.
    for (let t = 0; t < 120; t++) await h.step(0.5 + t * 0.002);
    const hour = h.rideWrites() - before;
    expect(hour).toBeLessThanOrEqual(60 * 60_000 / SAVE_MS + 1);
    expect(hour).toBeGreaterThanOrEqual(60 * 60_000 / SAVE_MS - 1);
    expect((await h.latest(id)).status).toBe(200);
    // A stage that was sent is written with its push, not up to 2 minutes later.
    const sent = h.rideWrites();
    await h.step(2);
    expect(pushCount(h)).toBe(1); expect(h.rideWrites() - sent).toBe(1);
    expect(h.db.prepare('SELECT sent_stage FROM dale_ride_alerts WHERE id=?').get(id)).toEqual({ sent_stage: 'three' });
    // A repeat of the same unconfirmed stage is not written; a restart then loses at most the newest positions, never the sent stage.
    const repeat = h.rideWrites();
    await h.step(2.01); expect(pushCount(h)).toBe(2); expect(h.rideWrites() - repeat).toBe(0);
    h.restart(); await h.step(2.02);
    expect(h.db.prepare('SELECT sent_stage FROM dale_ride_alerts WHERE id=?').get(id)).toEqual({ sent_stage: 'three' });
    expect((await h.latest(id)).body.stage).toBe('three');
  });

  it('keeps a service-change notice pending until the phone confirms it, across a restart, at most 5 more times', async () => {
    const h = await harness();
    const id = await h.start();
    h.feed.skipped = ['L6'];
    await h.step(2);
    expect(pushCount(h)).toBe(1);
    expect((await h.latest(id)).body).toEqual({ v: 1, kind: 'service_change', title: strings.en.ride.notifyTitle, body: strings.en.ride.lockedPush.serviceChange });
    // No acknowledgement (the phone's fetch failed): pushed again after 2 minutes, not sooner, even after a restart.
    h.feed.skipped = [];
    for (let i = 0; i < 3; i++) await h.step(3);
    expect(pushCount(h)).toBe(1);
    h.restart();
    await h.step(3); expect(pushCount(h)).toBe(2);
    // The flag outlives the report and the restart: no countdown is sent while it is set.
    expect((await h.latest(id)).body.kind).toBe('service_change');
    for (let i = 0; i < 40; i++) await h.step(i % 2 ? 3 : 3.05);
    expect(pushCount(h)).toBe(1 + NOTICE_REPUSHES);
    expect(h.pushes.every((p) => p.headers.get('topic') === id)).toBe(true);
    // An acknowledgement stops it at once, and repeats safely.
    const other = await harness();
    const ride = await other.start();
    other.feed.skipped = ['L6'];
    await other.step(2);
    expect((await other.post(`/v1/ride-alerts/${ride}/notice-ack`, {})).status).toBe(200);
    expect((await other.post(`/v1/ride-alerts/${ride}/notice-ack`, {})).status).toBe(200);
    for (let i = 0; i < 10; i++) await other.step(2);
    expect(pushCount(other)).toBe(1);
  });

  it('signs a payload-less VAPID push that verifies with the derived public key, and never exposes the endpoint', async () => {
    const h = await harness();
    const id = await h.start();
    await h.step(2);
    const push = h.pushes[0]!;
    expect(push.url).toBe('https://fcm.googleapis.com/fcm/send/synthetic-ride'); expect(push.bytes).toBe(0);
    expect(push.headers.get('ttl')).toBe(String(PUSH_TTL_SECONDS)); expect(push.headers.get('urgency')).toBe('high'); expect(push.headers.get('topic')).toBe(id);
    const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(push.headers.get('authorization')!)!;
    expect(match[2]).toBe(h.keys.publicKey);
    const [header, payload, signature] = match[1]!.split('.') as [string, string, string];
    const key = await crypto.subtle.importKey('raw', fromBase64Url(match[2]!)!, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(signature)!, new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(header)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    expect(claims.aud).toBe('https://fcm.googleapis.com'); expect(claims.sub).toBe(VAPID_SUBJECT);
    expect(claims.exp).toBeGreaterThan(h.now() / 1000); expect(claims.exp).toBeLessThanOrEqual(h.now() / 1000 + 12 * 3600);
    // Health shows only a count; no response carries the endpoint, trip or stops of a ride.
    const status = await h.health();
    expect(status.rideAlerts).toEqual({ active: 1 });
    const texts = [JSON.stringify(status), await (await h.api('/v1/collection')).text(), JSON.stringify((await h.latest(id)).body)];
    for (const text of texts) { expect(text).not.toContain('synthetic-ride'); expect(text).not.toContain(id); }
    expect(await (await h.api('/v1/collection')).json()).toMatchObject({ rideAlerts: { active: 1 } });
    // A tampered key pair is refused instead of signing pushes no browser accepts.
    const other = JSON.parse((await secrets()).VAPID_PRIVATE_KEY), mine = JSON.parse(h.keys.VAPID_PRIVATE_KEY!);
    expect(await loadVapid(JSON.stringify({ ...mine, d: other.d }))).toBeUndefined();
  });

  it('classifies push service answers', async () => {
    const vapid = (await loadVapid((await secrets()).VAPID_PRIVATE_KEY))!;
    const send = (respond: () => Promise<Response>) => sendPush(vapid, 'https://fcm.googleapis.com/x', 'topic', NOW, (async () => respond()) as typeof fetch);
    expect(await send(async () => new Response(null, { status: 201 }))).toBe('ok');
    for (const status of [404, 410]) expect(await send(async () => new Response(null, { status }))).toBe('gone');
    for (const status of [429, 500, 503]) expect(await send(async () => new Response(null, { status }))).toBe('retry');
    for (const status of [400, 403, 413, 302]) expect(await send(async () => new Response(null, { status }))).toBe('failed');
    expect(await send(async () => { throw new TypeError('offline'); })).toBe('retry');
  });
});

describe('ride expiry', () => {
  const rules = createRideRules(ds);
  const row = { id: 'x', trip: 'T1', date: '20261104', vehicle: 'bus-A', board: 0, alight: 5, createdAt: NOW, session: null } satisfies Partial<RideRow>;
  const scheduled = Date.parse('2026-11-04T12:25:00Z'); // 07:25 at L5
  const snap = (patch: Partial<LiveBusSnapshot> = {}): LiveBusSnapshot => ({ v: 1, source: 'NJ Transit GTFS-RT G2', feedVersion: ds.meta.feedVersion, tripInstanceId: INSTANCE, receivedAt: NOW,
    vehicles: { state: 'ok', timestamp: NOW - 1000 }, updates: { state: 'ok', timestamp: NOW - 1000 }, observations: [], predictions: [], skippedStops: [], ...patch });
  const session = (now: number, s: LiveBusSnapshot) => rules.apply(rules.session(row)!, s, now);
  it('is 30 minutes after the scheduled or later predicted arrival, ignoring outdated predictions', () => {
    expect(rules.expiry(row, session(NOW, snap()), snap(), NOW)).toBe(scheduled + 1800_000);
    const late = snap({ updatedAt: NOW - 1000, predictions: [{ stopIndex: 5, at: scheduled + 1200_000, observedAt: NOW - 1000, kind: 'arrival' }] });
    expect(rules.expiry(row, session(NOW, late), late, NOW)).toBe(scheduled + 3000_000);
    const outdated = snap({ predictions: [{ stopIndex: 5, at: scheduled + 1200_000, observedAt: NOW - 121_000, kind: 'arrival' }] });
    expect(rules.expiry(row, session(NOW, outdated), outdated, NOW)).toBe(scheduled + 1800_000);
    const otherStop = snap({ predictions: [{ stopIndex: 4, at: scheduled + 1200_000, observedAt: NOW - 1000, kind: 'arrival' }] });
    expect(rules.expiry(row, session(NOW, otherStop), otherStop, NOW)).toBe(scheduled + 1800_000);
  });
  it('treats a prediction over 30 minutes in the past as none, and then keeps a late bus with fresh positions, within the 3-hour cap', () => {
    const now = scheduled + 50 * 60_000;
    const position = { tripInstanceId: INSTANCE, vehicleId: 'bus-A', observedAt: now - 1000, lat: 40.89, lon: -74.05 };
    const stalePrediction = { stopIndex: 5, at: now - 31 * 60_000, observedAt: now - 1000, kind: 'arrival' as const };
    const s = snap({ receivedAt: now, vehicles: { state: 'ok', timestamp: now - 1000 }, updates: { state: 'ok', timestamp: now - 1000 }, updatedAt: now - 1000, observations: [position], predictions: [stalePrediction] });
    expect(rules.expiry(row, session(now, s), s, now)).toBe(now - 1000 + 1800_000);
    // Without the fallback the old prediction alone would have ended the ride already.
    const noBus = snap({ receivedAt: now, updatedAt: now - 1000, predictions: [stalePrediction] });
    expect(rules.expiry(row, session(now, noBus), noBus, now)).toBe(scheduled + 1800_000);
    const muchLater = NOW + RIDE_CAP_MS - 60_000;
    const capped = snap({ receivedAt: muchLater, vehicles: { state: 'ok', timestamp: muchLater - 1000 }, observations: [{ ...position, observedAt: muchLater - 1000 }] });
    expect(rules.expiry(row, session(muchLater, capped), capped, muchLater)).toBe(NOW + RIDE_CAP_MS);
  });
  it('extends only while the ride\'s own guide places the bus short of the alighting stop', () => {
    const now = scheduled + 50 * 60_000;
    const report = (stop: number) => {
      const s = snap({ receivedAt: now, vehicles: { state: 'ok', timestamp: now - 1000 }, updates: { state: 'ok', timestamp: now - 1000 },
        observations: [{ tripInstanceId: INSTANCE, vehicleId: 'bus-A', observedAt: now - 1000, lat: at(stop).latitude, lon: at(stop).longitude }] });
      return rules.expiry(row, session(now, s), s, now);
    };
    expect(report(4)).toBe(now - 1000 + 1800_000);
    // At or beyond the alighting stop (index 5), a fresh position never keeps the ride open.
    expect(report(5)).toBe(scheduled + 1800_000);
    expect(report(6)).toBe(scheduled + 1800_000);
  });
  it('ends a ride on time when the bus reports beyond the alighting stop during a service change', async () => {
    const h = await harness();
    const id = await h.start();
    h.feed.skipped = ['L3'];
    await h.step(2);
    // The service change pauses the countdown, so only expiry can end this ride; a bus past the stop does not extend it.
    for (let t = 0; t < 80 && (await h.latest(id)).status === 200; t++) await h.step(6);
    expect(await h.latest(id)).toEqual({ status: 410, body: { v: 1, kind: 'ended', reason: 'expired' } });
    expect(h.now()).toBeLessThanOrEqual(scheduled + 1800_000 + 30_000);
  });
  it('keeps a late bus\'s ride while it reports, ends it after, and drops the tombstone after expiry', async () => {
    const h = await harness();
    const id = await h.start();
    // 50 minutes later the bus is still short of the stop and reporting: the ride continues.
    for (let t = 0; t < 100; t++) await h.step(0.5 + t * 0.005);
    expect(h.now()).toBeGreaterThan(scheduled + 1800_000);
    expect((await h.latest(id)).status).toBe(200);
    const kept = Number(h.db.prepare('SELECT expires_at FROM dale_ride_alerts WHERE id=?').get(id)!.expires_at);
    // The stored expiry is written with the ride's other changes, so it can trail the newest position by under 2 minutes.
    expect(kept).toBeGreaterThan(h.now() + 27 * 60_000);
    // It stops reporting: 30 minutes after its last fresh position the ride ends, and the tombstone answers "ended".
    for (let t = 0; t < 61; t++) await h.step(null);
    expect(await h.latest(id)).toEqual({ status: 410, body: { v: 1, kind: 'ended', reason: 'expired' } });
    expect(h.alarmAt()).toBeNull();
    h.advance(11 * 60_000);
    expect((await h.latest(id)).status).toBe(404);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM dale_ride_alerts').get()!.n).toBe(0);
  });
  it('never keeps a ride past 3 hours from creation', async () => {
    const h = await harness();
    const id = await h.start();
    for (let t = 0; t < 400 && (await h.latest(id)).status === 200; t++) await h.step(0.5 + (t % 2) * 0.001, 30_000);
    expect(await h.latest(id)).toEqual({ status: 410, body: { v: 1, kind: 'ended', reason: 'expired' } });
    expect(h.now()).toBeLessThanOrEqual(NOW + RIDE_CAP_MS + 30_000);
    expect(h.now()).toBeGreaterThanOrEqual(NOW + RIDE_CAP_MS);
  });
});

describe('history collection with rides', () => {
  async function run(withRide: boolean) {
    const h = await harness({ collection: true });
    await h.api('/v1/collection');
    if (withRide) await h.start();
    for (let i = 0; i < 40; i++) {
      h.advance(5000);
      if (i === 17) h.feed.stop = 2;
      if (h.alarmAt() !== null && h.alarmAt()! <= h.now()) await h.alarm();
    }
    const collection = (await (await h.api('/v1/collection')).json()).collection;
    return { calls: h.calls, alarmAt: h.alarmAt(), observations: collection.observations, batches: collection.batches, pushes: h.pushes.length };
  }
  it.each([['collecting normally', false, 20 * 60_000], ['waiting at the storage limit', true, 150 * 60_000]] as const)(
    'runs history attempts, archive flush and prune at the same times with and without a ride (%s)', async (_, full, span) => {
      async function timing(withRide: boolean) {
        const flushes: number[] = [], prunes: number[] = [], attempts: number[] = [];
        const begin = HistoryJournal.prototype.beginAttempt;
        vi.spyOn(HistoryArchive.prototype, 'flush').mockImplementation(async (now: number) => { flushes.push(now); });
        vi.spyOn(HistoryJournal.prototype, 'pruneVerified').mockImplementation((now: number) => { prunes.push(now); });
        vi.spyOn(HistoryJournal.prototype, 'beginAttempt').mockImplementation(function (this: HistoryJournal, now: number) {
          const attempt = begin.call(this, now); if (attempt !== undefined) attempts.push(attempt); return attempt;
        });
        try {
          const h = await harness({ collection: true, archive: true });
          await h.api('/v1/collection');
          h.setFull(full);
          h.feed.stop = 0.5;
          if (withRide) await h.start();
          const end = h.now() + span;
          while (h.now() < end) { h.advance(5000); if (h.alarmAt() !== null && h.alarmAt()! <= h.now()) await h.alarm(); }
          const polls = h.calls.filter((c) => c.endpoint === 'getVehiclePositions').length, active = (await h.health()).rideAlerts.active;
          return { flushes, prunes, attempts, polls, active };
        } finally { vi.restoreAllMocks(); }
      }
      const plain = await timing(false), riding = await timing(true);
      expect(riding.flushes).toEqual(plain.flushes);
      expect(riding.prunes).toEqual(plain.prunes);
      expect(riding.attempts).toEqual(plain.attempts);
      expect(riding.active).toBe(1);
      if (full) {
        // Once an hour, as with no ride, while the ride kept polling every 30 seconds.
        expect(plain.attempts).toEqual([]);
        expect(plain.flushes.length).toBe(3);
        for (let i = 1; i < plain.flushes.length; i++) expect(plain.flushes[i]! - plain.flushes[i - 1]!).toBeGreaterThanOrEqual(3600_000);
        expect(plain.polls).toBe(0); expect(riding.polls).toBeGreaterThan(250);
      } else {
        expect(plain.flushes.length).toBeGreaterThan(30);
        expect(riding.polls).toBe(plain.polls);
      }
    });

  it('keeps the same upstream pacing, journal and alarm when collection is enabled', async () => {
    const plain = await run(false), riding = await run(true);
    expect(riding.calls).toEqual(plain.calls);
    expect(riding.alarmAt).toBe(plain.alarmAt);
    expect({ observations: riding.observations, batches: riding.batches }).toEqual({ observations: plain.observations, batches: plain.batches });
    expect(plain.observations).toBeGreaterThan(1);
    // The ride rode along on those same polls and alerted at "3 stops".
    expect(plain.pushes).toBe(0); expect(riding.pushes).toBeGreaterThanOrEqual(1);
  });
});
