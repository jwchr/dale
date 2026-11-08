import type { Dataset } from '../src/domain/types';
import { isServiceActive } from '../src/domain/schedule';
import { validServiceDate, validVehicleId, LIVE_SOURCE, type LiveBusSnapshot } from '../src/domain/liveBus';
import { authenticate, njtRequest, NjtError, safeNjtFailure, type Credentials } from './njt-client';
import { createNormalizer, type NormalizedFeed } from './normalize';
import { readDepartureRequests } from '../src/domain/liveDepartures';
import { summarizeDepartures } from './departures';
import { HistoryJournal, historyContextKey, HISTORY_INTERVAL_MS, type HistoryStorage } from './history-journal';
import { HistoryArchive, type HistoryBucket } from './history-archive';
interface Storage extends Partial<HistoryStorage> {
  get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>;
  getAlarm?(): Promise<number | null>; setAlarm?(at: number): Promise<void>; deleteAlarm?(): Promise<void>;
}
interface State { storage: Storage; blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> }
interface Env extends Credentials { HISTORY_COLLECTION?: string; HISTORY_ARCHIVE?: HistoryBucket; FEED: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }
interface ConnectionFailures { authentication?: { code: string; at: number }; vehicles?: { code: string; at: number }; updates?: { code: string; at: number } }
interface Saved { transportVersion?: number; failures?: ConnectionFailures; feedVersion?: string; token?: { value: string; expiresAt: number }; authAt: number; pollAt: number; vehicles?: NormalizedFeed; updates?: NormalizedFeed }
const unavailable = (): NormalizedFeed => ({ feed: { state: 'unavailable' }, observations: [], updates: [] });
const POLL_MS = HISTORY_INTERVAL_MS, AUTH_RETRY_MS = 3600_000;

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
          try {
            this.journal = new HistoryJournal(ctx.storage as HistoryStorage, ds, await historyContextKey(ds));
            this.journal.setEnabled(env.HISTORY_COLLECTION === 'enabled', clock());
            if (env.HISTORY_ARCHIVE && env.HISTORY_COLLECTION === 'enabled') this.archive = new HistoryArchive(ctx.storage as HistoryStorage, this.journal, env.HISTORY_ARCHIVE);
            if (env.HISTORY_COLLECTION !== 'enabled') {
              if (await ctx.storage.getAlarm() !== null) await ctx.storage.deleteAlarm();
            } else await this.arm();
          } catch { this.collectionError = true; }
        } else if (env.HISTORY_COLLECTION === 'enabled') this.collectionError = true;
      });
    }
    private async arm() {
      if (!this.journal || this.env.HISTORY_COLLECTION !== 'enabled' || !this.ctx.storage.getAlarm || !this.ctx.storage.setAlarm) return;
      const next = this.journal.status(clock()).nextAttemptAt;
      if (next !== null && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Math.max(clock() + 1000, next));
    }
    private async poll(background = false) {
      if (!this.pending && clock() - this.saved.pollAt >= POLL_MS) {
        let attempt: number | undefined;
        try { attempt = this.journal?.beginAttempt(clock()); } catch { this.collectionError = true; }
        // A paused/disabled collector must not start upstream work on its own.
        if (background && attempt === undefined) return;
        this.pending = (async () => {
          await this.refresh();
          if (attempt !== undefined) {
            try { this.journal!.complete(attempt, this.saved.vehicles ?? unavailable(), clock(), this.saved.updates); this.collectionError = false; }
            catch { this.collectionError = true; }
          }
        })().finally(() => { this.pending = undefined; });
      }
      await this.pending;
    }
    async alarm(): Promise<void> {
      await this.ready;
      if (this.env.HISTORY_COLLECTION !== 'enabled') return;
      try {
        await this.poll(true);
        if (this.archive) await this.archive.flush(clock());
        this.journal?.pruneVerified(clock());
      }
      finally {
        // Normal feed failures are persisted gaps. Unexpected storage/alarm errors
        // still throw so the platform's bounded retries remain available.
        await this.arm();
      }
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
        const fetchFeed = async (endpoint: 'getVehiclePositions' | 'getTripUpdates', kind: 'vehicles' | 'updates') => {
          // A cooldown is not a new endpoint attempt: retain the last failure until that feed retries.
          delete this.saved.failures![kind];
          try { return normalize(await njtRequest(endpoint, { token }, 8 * 1024 * 1024, fetchImpl), kind, clock()); }
          catch (error) {
            this.saved.failures![kind] = { code: safeNjtFailure(error), at: now };
            if (error instanceof NjtError && error.code === 'access-denied') this.saved.token = undefined;
            return unavailable();
          }
        };
        const [vehicles, updates] = await Promise.all([fetchFeed('getVehiclePositions', 'vehicles'), fetchFeed('getTripUpdates', 'updates')]);
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
      // Health reads never create evidence or trigger a demand refresh.
      if (url.pathname === '/v1/collection') {
        let collection: unknown;
        try { collection = this.journal ? { ...this.journal.status(clock()), error: this.collectionError,
          alarmAt: await this.ctx.storage.getAlarm?.() ?? null, archive: this.archive?.status(clock()) ?? { configured: !!this.env.HISTORY_ARCHIVE, enabled: false } } : { enabled: false, reason: this.collectionError ? 'storage-unavailable' : 'disabled' }; }
        catch { collection = { enabled: this.env.HISTORY_COLLECTION === 'enabled', reason: 'storage-unavailable', error: true }; }
        return Response.json({ v: 1, collection }, { headers: { 'cache-control': 'no-store' } });
      }
      await this.poll();
      try { await this.arm(); } catch { this.collectionError = true; }
      const trip = url.searchParams.get('trip')!, date = url.searchParams.get('date')!, vehicle = url.searchParams.get('vehicle');
      const id = `${trip}@${date}`, vehicles = this.saved.vehicles ?? unavailable(), updates = this.saved.updates ?? unavailable(), now = clock();
      // A successful fetch never refreshes the agency timestamps. Old retained data remains old.
      const age = (feed: NormalizedFeed) => ({ ...feed.feed, ...(feed.feed.timestamp && now - feed.feed.timestamp > 120_000 ? { state: 'stale' as const } : {}) });
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
        return Response.json({ v: 1, source: LIVE_SOURCE, feedVersion: ds.meta.feedVersion, collection,
        connectionFailures: this.saved.failures ?? {},
        vehicles: age(vehicles), updates: age(updates), vehicleDiagnostics: vehicles.diagnostics, updateDiagnostics: updates.diagnostics, reportingBuses: new Set(vehicles.observations.filter((o) => now - o.observedAt <= 120_000).map((o) => o.vehicleId)).size,
        example: vehicles.observations.filter((o) => now - o.observedAt <= 120_000).sort((a, b) => b.observedAt - a.observedAt)[0],
      }, { headers: { 'cache-control': 'no-store' } });
      }
      const candidates = updates.updates.filter((u) => u.tripInstanceId === id).sort((a, b) => b.observedAt - a.observedAt);
      const update = candidates.length === 1 ? candidates[0] : undefined;
      // Keep one newest report per trip/vehicle before bounding the public packet. Duplicates
      // must not hide a second bus on this trip or the locked bus moving to another trip.
      const exact = new Map<string, (typeof vehicles.observations)[number]>();
      let reassigned: (typeof vehicles.observations)[number] | undefined;
      for (const point of vehicles.observations) {
        if (point.tripInstanceId === id) {
          if (!exact.has(point.vehicleId) || point.observedAt > exact.get(point.vehicleId)!.observedAt) exact.set(point.vehicleId, point);
        } else if (point.vehicleId === vehicle && (!reassigned || point.observedAt > reassigned.observedAt)) reassigned = point;
      }
      const observations = [...(reassigned ? [reassigned] : []), ...[...exact.values()].sort((a, b) => b.observedAt - a.observedAt)].slice(0, 10);
      const response: LiveBusSnapshot = {
        v: 1, source: LIVE_SOURCE, feedVersion: ds.meta.feedVersion, tripInstanceId: id, receivedAt: now,
        vehicles: age(vehicles), updates: age(updates),
        observations,
        ...(update ? { updatedAt: update.observedAt } : {}),
        ...(update?.cancelled ? { cancelledAt: update.observedAt } : {}),
        predictions: update?.predictions ?? [], skippedStops: update?.skippedStops ?? [],
      };
      return Response.json(response, { headers: { 'cache-control': 'no-store' } });
    }
  };
}

export function createRouter(ds: Dataset) {
  const schedule = JSON.stringify(ds), trips = new Map(ds.trips.map((t) => [t.id, t]));
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const origin = request.headers.get('origin'), url = new URL(request.url);
      const headers = new Headers({ 'access-control-allow-origin': 'https://jwchr.github.io', 'vary': 'Origin', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      const reply = (body: string | null, status = 200) => new Response(body, { status, headers });
      if (origin && origin !== 'https://jwchr.github.io') return reply('Origin not allowed', 403);
      if (request.method === 'OPTIONS') { headers.set('access-control-allow-methods', 'GET'); return reply(null, 204); }
      if (request.method !== 'GET') return reply('Method not allowed', 405);
      if (url.pathname === '/health') { headers.set('content-type', 'application/json'); return reply(JSON.stringify({ v: 1, feedVersion: ds.meta.feedVersion, source: LIVE_SOURCE })); }
      if (url.pathname === '/v1/schedule') { headers.set('content-type', 'application/json'); return reply(schedule); }
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
