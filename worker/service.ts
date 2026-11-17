import { parseRouteGeometry, MAX_GEOMETRY_BYTES } from '../src/domain/routeDistance';
import type { Dataset } from '../src/domain/types';
import { isServiceActive } from '../src/domain/schedule';
import { validServiceDate, validVehicleId, LIVE_SOURCE, type LiveBusSnapshot } from '../src/domain/liveBus';
import { authenticate, njtRequest, NjtError, safeNjtFailure, type Credentials } from './njt-client';
import { createNormalizer, type NormalizedFeed } from './normalize';
import { readDepartureRequests } from '../src/domain/liveDepartures';
import { summarizeDepartures } from './departures';
import { HistoryJournal, historyContextKey, HISTORY_INTERVAL_MS, type HistoryStorage } from './history-journal';
import { HistoryArchive, type HistoryBucket } from './history-archive';
import { RideAlerts, RIDE_PATH, MAX_BODY_BYTES, type RideEnv } from './ride-alerts';
interface Storage extends Partial<HistoryStorage> {
  get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>;
  getAlarm?(): Promise<number | null>; setAlarm?(at: number): Promise<void>; deleteAlarm?(): Promise<void>;
}
interface State { storage: Storage; blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> }
interface Env extends Credentials, RideEnv { HISTORY_COLLECTION?: string; HISTORY_CADENCE_TEST_UNTIL?: string; HISTORY_ARCHIVE?: HistoryBucket; FEED: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }
interface ConnectionFailures { authentication?: { code: string; at: number }; vehicles?: { code: string; at: number }; updates?: { code: string; at: number } }
interface Saved { transportVersion?: number; failures?: ConnectionFailures; feedVersion?: string; token?: { value: string; expiresAt: number }; authAt: number; pollAt: number; vehicles?: NormalizedFeed; updates?: NormalizedFeed }
const unavailable = (): NormalizedFeed => ({ feed: { state: 'unavailable' }, observations: [], updates: [] });
const POLL_MS = HISTORY_INTERVAL_MS, AUTH_RETRY_MS = 3600_000;
// A successful fetch never refreshes the agency timestamps. Old retained data remains old.
const aged = (feed: NormalizedFeed, now: number) => ({ ...feed.feed, ...(feed.feed.timestamp && now - feed.feed.timestamp > 120_000 ? { state: 'stale' as const } : {}) });

/** One private object serializes demand/alarm polling and token reuse. Collection is explicitly enabled by reviewed deployment. */
export function createFeedClass(ds: Dataset, fetchImpl: typeof fetch = fetch, clock = Date.now) {
  const normalize = createNormalizer(ds);
  return class Feed {
    private saved: Saved = { transportVersion: 2, feedVersion: ds.meta.feedVersion, authAt: 0, pollAt: 0 };
    private pending?: Promise<void>;
    private ready: Promise<void>;
    private ctx: State;
    private env: Env;
    private journal?: HistoryJournal;
    private archive?: HistoryArchive;
    private collectionError = false;
    private upstreamVehicleAttempts = 0;
    private rides?: RideAlerts;
    constructor(ctx: State, env: Env) {
      this.ctx = ctx; this.env = env;
      this.ready = ctx.blockConcurrencyWhile(async () => {
        const stored = await ctx.storage.get<Saved>('state-v1');
        if (stored && Number.isFinite(stored.authAt) && Number.isFinite(stored.pollAt)) {
          this.saved = {
            ...stored, transportVersion: 2, feedVersion: ds.meta.feedVersion,
            ...(stored.feedVersion === ds.meta.feedVersion ? {} : { vehicles: undefined, updates: undefined }),
          };
          // Legacy redirect:'error' failed during workerd Request construction, before any
          // NJ Transit request. Release only that known failure once; preserve real denials,
          // valid tokens, the global poll pace and every failure from the fixed transport.
          if (stored.transportVersion === undefined && !stored.token && stored.failures?.authentication?.code === 'network-error') this.saved.authAt = 0;
          if (stored.transportVersion !== 2) await ctx.storage.put('state-v1', this.saved);
        }
        if (ctx.storage.sql && ctx.storage.transactionSync && ctx.storage.getAlarm && ctx.storage.setAlarm && ctx.storage.deleteAlarm) {
          // Locked-phone stop alerts (#176 step C) keep their short-lived rides in the same SQLite storage.
          try { this.rides = new RideAlerts(ctx.storage as HistoryStorage, ds, { snapshot: (...a) => this.snapshot(...a), arm: (changed) => this.arm(changed) }, clock, fetchImpl); }
          catch { this.rides = undefined; }
          try {
            this.journal = new HistoryJournal(ctx.storage as HistoryStorage, ds, await historyContextKey(ds));
            this.journal.setEnabled(env.HISTORY_COLLECTION === 'enabled', clock());
            this.journal.setCadenceTest(env.HISTORY_CADENCE_TEST_UNTIL, clock());
            // A reset can happen before refresh persists its cache. The durable
            // attempt reservation remains the conservative shared pace anchor.
            this.saved.pollAt = Math.max(this.saved.pollAt, this.journal.status(clock()).lastAttemptAt ?? 0);
            if (env.HISTORY_ARCHIVE && env.HISTORY_COLLECTION === 'enabled') this.archive = new HistoryArchive(ctx.storage as HistoryStorage, this.journal, env.HISTORY_ARCHIVE);
            // With collection off, an alarm runs only while a ride needs checking.
            if (env.HISTORY_COLLECTION !== 'enabled' && this.rideWake() === null) {
              if (await ctx.storage.getAlarm() !== null) await ctx.storage.deleteAlarm();
            } else await this.arm();
          } catch { this.collectionError = true; }
        } else if (env.HISTORY_COLLECTION === 'enabled') this.collectionError = true;
      });
    }
    /** When rides next need the alarm: the global poll pace while one is active; null with no ride. */
    private rideWake(): number | null {
      try { return this.rides?.nextWake(this.saved.pollAt + POLL_MS) ?? null; } catch { return null; }
    }
    private async arm(ridesChanged = false) {
      const collecting = !!this.journal && this.env.HISTORY_COLLECTION === 'enabled', rideAt = this.rideWake();
      if (!this.ctx.storage.getAlarm || !this.ctx.storage.setAlarm) return;
      // Collection off and no ride: no alarm, so nothing polls NJ Transit in the background.
      if (!collecting && rideAt === null) {
        if (ridesChanged && this.ctx.storage.deleteAlarm && await this.ctx.storage.getAlarm() !== null) await this.ctx.storage.deleteAlarm();
        return;
      }
      let next = collecting ? this.journal!.status(clock()).nextAttemptAt : null;
      if (rideAt !== null) next = next === null ? rideAt : Math.min(next, rideAt);
      if (next !== null) {
        const desired = Math.max(clock() + 1000, next), existing = await this.ctx.storage.getAlarm();
        if (existing === null || existing > desired) await this.ctx.storage.setAlarm(desired);
      }
    }
    private async poll(background = false, forRides = false) {
      if (!this.pending && clock() - this.saved.pollAt >= (this.journal?.intervalMs(clock()) ?? POLL_MS)) {
        let attempt: number | undefined;
        try { attempt = this.journal?.beginAttempt(clock()); } catch { this.collectionError = true; }
        // A paused/disabled collector must not start upstream work on its own. An active ride
        // may, at the same global pace (pollAt above) as a demand read from an open app.
        if (background && attempt === undefined && !forRides) return;
        this.pending = (async () => {
          const beforeVehicleAttempts = this.upstreamVehicleAttempts;
          await this.refresh();
          if (attempt !== undefined) {
            try { this.journal!.complete(attempt, this.saved.vehicles ?? unavailable(), clock(), this.saved.updates, this.upstreamVehicleAttempts > beforeVehicleAttempts); this.collectionError = false; }
            catch { this.collectionError = true; }
          }
        })().finally(() => { this.pending = undefined; });
      }
      await this.pending;
    }
    async alarm(): Promise<void> {
      await this.ready;
      const collecting = this.env.HISTORY_COLLECTION === 'enabled', rideAt = this.rideWake();
      if (!collecting && rideAt === null) return;
      // An alarm set early only for a ride leaves collection to its own due time, so its pacing is unchanged.
      let collect = collecting;
      if (collecting && rideAt !== null && this.journal) {
        try { const due = this.journal.status(clock()).nextAttemptAt; collect = due === null || due <= clock() + 1000; } catch { collect = true; }
      }
      try {
        if (collect) {
          await this.poll(true);
          if (this.archive) await this.archive.flush(clock());
          this.journal?.pruneVerified(clock());
        }
      }
      finally {
        // Ride checks never throw into collection; they piggyback on the poll above when it ran.
        if (rideAt !== null) await this.watchRides();
        // Normal feed failures are persisted gaps. Unexpected storage/alarm errors
        // still throw so the platform's bounded retries remain available.
        await this.arm(rideAt !== null);
      }
    }
    private async watchRides() {
      const rides = this.rides;
      if (!rides) return;
      try {
        rides.store.purge(clock());
        if (rides.activeCount() === 0) return;
        await this.poll(true, true);
        await rides.watch(this.env);
      } catch { /* A failed ride check is retried on the next alarm; it never reveals a ride. */ }
    }
    /** The /v1/live answer for one trip instance and optional locked vehicle, from the latest poll. */
    private snapshot(trip: string, date: string, vehicle: string | null, now: number): LiveBusSnapshot {
      const id = `${trip}@${date}`, vehicles = this.saved.vehicles ?? unavailable(), updates = this.saved.updates ?? unavailable();
      const candidates = updates.updates.filter((u) => u.tripInstanceId === id).sort((a, b) => b.observedAt - a.observedAt);
      const update = candidates.length === 1 ? candidates[0] : undefined;
      // Keep distinct buses and reassignment evidence, but never choose an arbitrary
      // coordinate when a trip/vehicle has conflicting fixes at its newest timestamp.
      const groups = new Map<string, (typeof vehicles.observations)>();
      for (const point of vehicles.observations) {
        if (point.tripInstanceId !== id && point.vehicleId !== vehicle) continue;
        const key = JSON.stringify([point.tripInstanceId, point.vehicleId]), previous = groups.get(key);
        if (!previous || point.observedAt > previous[0]!.observedAt) groups.set(key, [point]);
        else if (point.observedAt === previous[0]!.observedAt) previous.push(point);
      }
      let conflictingGPS = false;
      const qualified: (typeof vehicles.observations) = [];
      for (const points of groups.values()) {
        const signatures = new Set(points.map(p => JSON.stringify([p.lat, p.lon, p.stopCall ?? null])));
        if (signatures.size > 1) conflictingGPS = true;
        else qualified.push(points[0]!);
      }
      const exact = qualified.filter(p => p.tripInstanceId === id).sort((a, b) => b.observedAt - a.observedAt);
      const reassigned = qualified.filter(p => p.tripInstanceId !== id).sort((a, b) => b.observedAt - a.observedAt);
      // Two distinct reassignment reports preserve uncertainty without crowding out
      // every exact-trip vehicle. Any further omitted reassignment is invalid data.
      if (reassigned.length > 2) conflictingGPS = true;
      const observations = [...reassigned.slice(0, 2), ...exact].slice(0, 10);
      return {
        v: 1, source: LIVE_SOURCE, feedVersion: ds.meta.feedVersion, tripInstanceId: id, receivedAt: now,
        vehicles: conflictingGPS ? { ...aged(vehicles, now), state: 'invalid' } : aged(vehicles, now), updates: aged(updates, now),
        observations,
        ...(update ? { updatedAt: update.observedAt } : {}),
        ...(update?.cancelled ? { cancelledAt: update.observedAt } : {}),
        predictions: update?.predictions ?? [], skippedStops: update?.skippedStops ?? [],
      };
    }
    private async refresh(): Promise<void> {
      const now = clock(); this.saved.pollAt = now;
      // Persist the pace limit before I/O, so an eviction cannot multiply upstream requests.
      await this.ctx.storage.put('state-v1', this.saved);
      this.saved.failures = { ...this.saved.failures };
      try {
        if (!this.saved.token || this.saved.token.expiresAt <= now) {
          if (now - this.saved.authAt < AUTH_RETRY_MS) throw new NjtError('authentication-cooldown');
          this.saved.authAt = now;
          await this.ctx.storage.put('state-v1', this.saved);
          this.saved.token = { value: await authenticate(this.env, fetchImpl), expiresAt: now + 20 * 3600_000 };
          delete this.saved.failures.authentication;
          await this.ctx.storage.put('state-v1', this.saved);
        }
        const token = this.saved.token.value;
        // One endpoint refusing the token must not cut off the other: keep the shared token while a
        // feed still works with it. A refusal with no working feed drops it, so login is retried
        // (within the existing one-hour cooldown) instead of reusing a dead token until it expires.
        let denials = 0, successes = 0;
        const fetchFeed = async (endpoint: 'getVehiclePositions' | 'getTripUpdates', kind: 'vehicles' | 'updates') => {
          // A cooldown is not a new endpoint attempt: retain the last failure until that feed retries.
          delete this.saved.failures![kind];
          if (endpoint === 'getVehiclePositions') this.upstreamVehicleAttempts++;
          try { const feed = normalize(await njtRequest(endpoint, { token }, 8 * 1024 * 1024, fetchImpl), kind, clock()); if (feed.feed.state !== 'invalid') successes++; return feed; }
          catch (error) {
            this.saved.failures![kind] = { code: safeNjtFailure(error), at: now };
            if (error instanceof NjtError && error.code === 'access-denied') denials++;
            return unavailable();
          }
        };
        const [vehicles, updates] = await Promise.all([fetchFeed('getVehiclePositions', 'vehicles'), fetchFeed('getTripUpdates', 'updates')]);
        if (denials > 0 && successes === 0) this.saved.token = undefined;
        this.saved.vehicles = vehicles; this.saved.updates = updates;
      } catch (error) {
        // Preserve the original failure throughout authentication cooldown instead of hiding it.
        if (!(error instanceof NjtError && error.code === 'authentication-cooldown' && this.saved.failures.authentication))
          this.saved.failures.authentication = { code: safeNjtFailure(error), at: now };
        this.saved.vehicles = unavailable(); this.saved.updates = unavailable();
      }
      await this.ctx.storage.put('state-v1', this.saved);
    }
    async fetch(request: Request): Promise<Response> {
      await this.ready;
      const url = new URL(request.url);
      // Ride alert routes never trigger a demand refresh; the alarm polls for active rides.
      if (url.pathname === '/v1/ride-alerts' || url.pathname.startsWith('/v1/ride-alerts/')) {
        if (this.rides) return this.rides.handle(request, this.env);
        return Response.json({ v: 1, available: false }, { status: url.pathname === '/v1/ride-alerts/config' ? 200 : 503, headers: { 'cache-control': 'no-store' } });
      }
      // Health reads never create evidence or trigger a demand refresh.
      if (url.pathname === '/v1/collection') {
        let collection: unknown;
        try { collection = this.journal ? { ...this.journal.status(clock()), error: this.collectionError,
          alarmAt: await this.ctx.storage.getAlarm?.() ?? null, archive: this.archive?.status(clock()) ?? { configured: !!this.env.HISTORY_ARCHIVE, enabled: false } } : { enabled: false, reason: this.collectionError ? 'storage-unavailable' : 'disabled' }; }
        catch { collection = { enabled: this.env.HISTORY_COLLECTION === 'enabled', reason: 'storage-unavailable', error: true }; }
        return Response.json({ v: 1, collection, rideAlerts: this.rideHealth() }, { headers: { 'cache-control': 'no-store' } });
      }
      await this.poll();
      try { await this.arm(); } catch { this.collectionError = true; }
      const trip = url.searchParams.get('trip')!, date = url.searchParams.get('date')!, vehicle = url.searchParams.get('vehicle');
      const vehicles = this.saved.vehicles ?? unavailable(), updates = this.saved.updates ?? unavailable(), now = clock();
      const age = (feed: NormalizedFeed) => aged(feed, now);
      if (url.pathname === '/v1/departures') {
        const queries = readDepartureRequests(ds, url.searchParams.get('q'));
        return Response.json({ v: 1, source: LIVE_SOURCE, feedVersion: ds.meta.feedVersion, receivedAt: now,
          vehicles: age(vehicles), updates: age(updates), items: summarizeDepartures(ds, queries, vehicles, updates, now),
        }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/v1/status') {
        let collection: unknown = { enabled: false, reason: 'disabled' };
        try {
          if (this.journal) collection = { ...this.journal.status(now), error: this.collectionError,
            alarmAt: await this.ctx.storage.getAlarm?.() ?? null, archive: this.archive?.status(now) ?? { configured: !!this.env.HISTORY_ARCHIVE, enabled: false } };
          else if (this.collectionError) collection = { enabled: false, reason: 'storage-unavailable', error: true };
        } catch { collection = { enabled: this.env.HISTORY_COLLECTION === 'enabled', reason: 'storage-unavailable', error: true }; }
        return Response.json({ v: 1, source: LIVE_SOURCE, feedVersion: ds.meta.feedVersion, collection, rideAlerts: this.rideHealth(),
        connectionFailures: this.saved.failures ?? {},
        vehicles: age(vehicles), updates: age(updates), vehicleDiagnostics: vehicles.diagnostics, updateDiagnostics: updates.diagnostics, reportingBuses: new Set(vehicles.observations.filter((o) => now - o.observedAt <= 120_000).map((o) => o.vehicleId)).size,
        example: vehicles.observations.filter((o) => now - o.observedAt <= 120_000).sort((a, b) => b.observedAt - a.observedAt)[0],
      }, { headers: { 'cache-control': 'no-store' } });
      }
      return Response.json(this.snapshot(trip, date, vehicle, now), { headers: { 'cache-control': 'no-store' } });
    }
    /** Health shows only how many rides are active: never ids, push addresses, trips or stops. */
    private rideHealth() {
      try { return { active: this.rides?.activeCount() ?? 0 }; } catch { return { active: 0 }; }
    }
  };
}

/** The one method each ride alert route takes (docs/LOCKED_STOP_ALERTS.md, ride alerts API); undefined is not a route. */
function rideMethod(path: string): 'GET' | 'POST' | 'DELETE' | undefined {
  if (path === '/v1/ride-alerts/config') return 'GET';
  if (path === '/v1/ride-alerts') return 'POST';
  const match = RIDE_PATH.exec(path);
  if (!match) return;
  return !match[2] ? 'DELETE' : match[2] === 'latest' ? 'GET' : 'POST';
}

export function createRouter(ds: Dataset, rawGeometry?: unknown) {
  // Static delivery only: geometry is never passed to the recorder or upstream poller.
  let geometry: string | undefined;
  if (rawGeometry != null) {
    try {
      const text = JSON.stringify(rawGeometry);
      if (new TextEncoder().encode(text).byteLength <= MAX_GEOMETRY_BYTES) geometry = JSON.stringify(parseRouteGeometry(rawGeometry, ds));
    } catch { /* Optional malformed geometry disables distance, never the recorder/router. */ }
  }
  const schedule = JSON.stringify(ds), trips = new Map(ds.trips.map((t) => [t.id, t]));
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const origin = request.headers.get('origin'), url = new URL(request.url);
      const headers = new Headers({ 'access-control-allow-origin': 'https://jwchr.github.io', 'vary': 'Origin', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      const reply = (body: string | null, status = 200) => new Response(body, { status, headers });
      if (origin && origin !== 'https://jwchr.github.io') return reply('Origin not allowed', 403);
      if (request.method === 'OPTIONS') {
        headers.set('access-control-allow-methods', 'GET, POST, DELETE'); headers.set('access-control-allow-headers', 'content-type'); headers.set('access-control-max-age', '600');
        return reply(null, 204);
      }
      if (url.pathname === '/v1/ride-alerts' || url.pathname.startsWith('/v1/ride-alerts/')) {
        // Locked-phone stop alerts (#176 step C): JSON in and out, never cached, and writes only from Dale's own page.
        headers.set('content-type', 'application/json');
        const fail = (error: string, status: number) => reply(JSON.stringify({ v: 1, error }), status);
        const method = rideMethod(url.pathname);
        if (!method) return fail('unknown', 404);
        if (request.method !== method) return fail('method', 405);
        let forward = request;
        if (method !== 'GET' && !origin) return fail('origin', 403);
        if (method === 'POST') {
          if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return fail('invalid', 400);
          if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return fail('size', 413);
          let text: string;
          try { text = await request.text(); } catch { return fail('invalid', 400); }
          if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return fail('size', 413);
          try { JSON.parse(text); } catch { return fail('invalid', 400); }
          const address = request.headers.get('cf-connecting-ip');
          forward = new Request(request.url, { method: 'POST', body: text, headers: { 'content-type': 'application/json', ...(address ? { 'cf-connecting-ip': address } : {}) } });
        }
        try {
          const response = await env.FEED.get(env.FEED.idFromName('corridor-v1')).fetch(forward);
          if (response.status === 204) { headers.delete('content-type'); return reply(null, 204); }
          return reply(await response.text(), response.status);
        } catch { return reply(JSON.stringify({ v: 1, available: false }), 503); }
      }
      if (request.method !== 'GET') return reply('Method not allowed', 405);
      if (url.pathname === '/health') { headers.set('content-type', 'application/json'); return reply(JSON.stringify({ v: 1, feedVersion: ds.meta.feedVersion, source: LIVE_SOURCE })); }
      if (url.pathname === '/v1/schedule') { headers.set('content-type', 'application/json'); return reply(schedule); }
      if (url.pathname === '/v1/geometry') {
        if (url.searchParams.get('feedVersion') !== ds.meta.feedVersion) return reply('Feed mismatch', 409);
        if (!geometry) return reply('Geometry unavailable', 404);
        headers.set('content-type', 'application/json');
        headers.set('cache-control', 'public, max-age=300');
        return reply(geometry);
      }
      if (!['/v1/live', '/v1/status', '/v1/departures', '/v1/collection'].includes(url.pathname)) return reply('Not found', 404);
      if (url.pathname === '/v1/departures') {
        try { if (request.url.length > 16_384) return reply('Invalid departures', 400); readDepartureRequests(ds, url.searchParams.get('q')); } catch { return reply('Invalid departures', 400); }
      }
      const trip = url.searchParams.get('trip'), date = url.searchParams.get('date'), vehicle = url.searchParams.get('vehicle');
      if (url.pathname === '/v1/live' && (!trip || !trips.has(trip) || !date || !validServiceDate(date) || !isServiceActive(ds.calendars[trips.get(trip)!.serviceId], date) || (vehicle !== null && !validVehicleId(vehicle)))) return reply('Invalid trip', 400);
      try {
        const id = env.FEED.idFromName('corridor-v1');
        const response = await env.FEED.get(id).fetch(request);
        headers.set('content-type', 'application/json');
        return reply(await response.text(), response.status);
      } catch { return reply('Live feed unavailable', 503); }
    },
  };
}
