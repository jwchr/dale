import { parseRouteGeometry, MAX_GEOMETRY_BYTES } from '../src/domain/routeDistance';
import { parseRescueSchedule, RESCUE_SCHEDULE_MAX_BYTES } from '../src/domain/rescueSchedule';
import type { Dataset } from '../src/domain/types';
import { isServiceActive } from '../src/domain/schedule';
import { validServiceDate, validVehicleId, LIVE_SOURCE, type LiveBusSnapshot } from '../src/domain/liveBus';
import { authenticate, njtRequest, NjtError, RAW_RESPONSE_MAX_BYTES, safeNjtFailure, type Credentials } from './njt-client';
import { reserveRequests, type RequestBudget } from './request-budget';
import { RailGtfsrt, newRailGtfsrtState, type RailGtfsrtState } from './rail-gtfsrt';
import { createNormalizer, type NormalizedFeed } from './normalize';
import { readDepartureRequests } from '../src/domain/liveDepartures';
import { summarizeDepartures } from './departures';
import { HistoryJournal, historyContextKey, HISTORY_INTERVAL_MS, type HistoryStorage } from './history-journal';
import { HistoryArchive, type HistoryBucket } from './history-archive';
import { RawArchive, newRawArchiveState, rawBudgetPausesRail, startRailBudgetRetry, type RawArchiveState, type RawResponse } from './raw-archive';
import { filterRegionRaw, readRegionRoutes } from './region-raw';
import { RideAlerts, RIDE_PATH, MAX_BODY_BYTES, type RideEnv } from './ride-alerts';
import { RailBoards, RAIL_STATIONS } from './rail';
import { ArrivalConfidence } from './arrival-confidence';
import { EarlierBuses } from './earlier-buses';
import { OwnerHistory, OWNER_HISTORY_PATH, ownerAuthorization, ownerQuery } from './owner-history';
import { parseEarlierQuery } from '../src/domain/earlierBuses';
import { ArrivalBackfill, type ArchiveReader } from './arrival-backfill';
import { parseConfidenceQuery } from '../src/domain/arrivalConfidence';
interface Storage extends Partial<HistoryStorage> {
  get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>;
  getAlarm?(): Promise<number | null>; setAlarm?(at: number): Promise<void>; deleteAlarm?(): Promise<void>;
}
interface State { storage: Storage; blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> }
interface Env extends Credentials, RideEnv { RAW_ARCHIVE?: string; RAIL_GTFSRT_RAW?: string; HISTORY_COLLECTION?: string; HISTORY_CADENCE_TEST_UNTIL?: string; ARRIVAL_BACKFILL?: string; ARRIVAL_CONFIDENCE?: string; EARLIER_BUSES?: string; OWNER_HISTORY_SECRET?: string; HISTORY_ARCHIVE?: HistoryBucket; FEED: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }
interface ConnectionFailures { authentication?: { code: string; at: number }; vehicles?: { code: string; at: number }; updates?: { code: string; at: number } }
interface Saved { busBudget?: RequestBudget; railGtfsrt?: RailGtfsrtState; rawArchive?: RawArchiveState; transportVersion?: number; failures?: ConnectionFailures; feedVersion?: string; token?: { value: string; expiresAt: number }; authAt: number; pollAt: number; historyAt?: number; vehicles?: NormalizedFeed; updates?: NormalizedFeed }
const unavailable = (): NormalizedFeed => ({ feed: { state: 'unavailable' }, observations: [], updates: [] });
const POLL_MS = HISTORY_INTERVAL_MS, AUTH_RETRY_MS = 3600_000;
// A successful fetch never refreshes the agency timestamps. Old retained data remains old.
const aged = (feed: NormalizedFeed, now: number) => ({ ...feed.feed, ...(feed.feed.timestamp && now - feed.feed.timestamp > 120_000 ? { state: 'stale' as const } : {}) });

/** One private object serializes demand/alarm polling and token reuse. Collection is explicitly enabled by reviewed deployment. */
export function createFeedClass(ds: Dataset, fetchImpl: typeof fetch = fetch, clock = Date.now, region: unknown = null) {
  const normalize = createNormalizer(ds);
  const regionRoutes = readRegionRoutes(region, ds.meta.feedVersion);
  return class Feed {
    private saved: Saved = { transportVersion: 2, feedVersion: ds.meta.feedVersion, authAt: 0, pollAt: 0 };
    private pending?: Promise<void>;
    private ready: Promise<void>;
    private ctx: State;
    private env: Env;
    private journal?: HistoryJournal;
    private archive?: HistoryArchive;
    private rawArchive?: RawArchive;
    private rawSaving = false;
    private rawStatus() {
      if (!this.rawArchive) return undefined;
      return { ...this.rawArchive.status(), saving: this.rawSaving,
        ...(this.rawSaving && !regionRoutes ? { reason: 'region-unavailable' } : {}) };
    }
    private collectionError = false;
    private upstreamVehicleAttempts = 0;
    private rides?: RideAlerts;
    private rail: RailBoards;
    /** "How sure are we?" aggregates (#91): derived counts only, folded from the private hot batches. */
    private confidence?: ArrivalConfidence;
    private earlier?: EarlierBuses;
    private backfill?: ArrivalBackfill;
    /**
     * When history collection's own alarm is due: exactly the time the alarm would hold with no ride. Ride
     * wakes share the one alarm but never move this, so collection, archive flush and prune keep their
     * schedule while a ride is active. With no ride the alarm itself holds it; while a ride is active or
     * pending it is also stored, so a restart keeps it.
     */
    private historyAt: number | null = null;
    constructor(ctx: State, env: Env) {
      this.ctx = ctx; this.env = env;
      // Live trains (#80) keep their own token and pace; they never trigger a bus refresh.
      this.rail = new RailBoards(ctx.storage, env, fetchImpl, clock);
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
            const contextKey = await historyContextKey(ds);
            this.journal = new HistoryJournal(ctx.storage as HistoryStorage, ds, contextKey, env.EARLIER_BUSES === 'public');
            if (env.EARLIER_BUSES === 'public') {
              try { this.earlier = new EarlierBuses(ctx.storage as HistoryStorage, ds, contextKey); } catch { /* unavailable */ }
            }
            // Derived aggregates never stop collection: a failure here only leaves the endpoint unavailable.
            try {
              this.confidence = new ArrivalConfidence(ctx.storage as HistoryStorage, ds, contextKey);
              const reader = env.HISTORY_ARCHIVE as unknown as Partial<ArchiveReader> | undefined;
              if (env.HISTORY_COLLECTION === 'enabled' && env.ARRIVAL_BACKFILL && typeof reader?.list === 'function' && typeof reader.get === 'function')
                this.backfill = new ArrivalBackfill(ctx.storage as HistoryStorage, this.confidence, reader as ArchiveReader, ds, contextKey, env.ARRIVAL_BACKFILL);
            } catch { this.confidence = undefined; this.backfill = undefined; }
            this.journal.setEnabled(env.HISTORY_COLLECTION === 'enabled', clock());
            this.journal.setCadenceTest(env.HISTORY_CADENCE_TEST_UNTIL, clock());
            // A reset can happen before refresh persists its cache. The durable
            // attempt reservation remains the conservative shared pace anchor.
            this.saved.pollAt = Math.max(this.saved.pollAt, this.journal.status(clock()).lastAttemptAt ?? 0);
            if (env.HISTORY_ARCHIVE && env.HISTORY_COLLECTION === 'enabled') {
              this.archive = new HistoryArchive(ctx.storage as HistoryStorage, this.journal, env.HISTORY_ARCHIVE);
            }
            // Statewide raw saving shares the 39 GB archive guard (D79) with corridor history, behind a
            // corridor reserve (D78), so it is opt-in (Jeff, Nov 24, 2026): until RAW_ARCHIVE is 'enabled',
            // no bus or rail original is saved. Turned off, it still drains: interrupted saves get their
            // manifests and open hourly ledgers close, without saving anything new.
            const rawState = this.saved.rawArchive;
            this.rawSaving = env.RAW_ARCHIVE === 'enabled';
            const draining = !this.rawSaving && !!rawState && (rawState.pending.length > 0 || Object.keys(rawState.ledgers).length > 0);
            if (this.archive && env.HISTORY_ARCHIVE && (this.rawSaving || draining)) {
              this.saved.rawArchive ??= newRawArchiveState();
              this.rawArchive = new RawArchive(this.saved.rawArchive, this.archive, env.HISTORY_ARCHIVE,
                () => ctx.storage.put('state-v1', this.saved));
            }
            if (env.HISTORY_COLLECTION === 'enabled') this.historyAt = this.rideWake() === null ? await ctx.storage.getAlarm() : this.saved.historyAt ?? null;
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
    /**
     * When the next history run is due, by the same rule as with no ride: the earliest due time asked for since
     * the last history run. A later call can only keep or bring it forward, so fixing it before a ride's pushes
     * means slow pushes never make it later. Stored while a ride is active, so a restart keeps it.
     */
    private async planHistory(rideAt: number | null): Promise<number | null> {
      if (!this.journal || this.env.HISTORY_COLLECTION !== 'enabled') return null;
      const due = this.journal.status(clock()).nextAttemptAt, desired = due === null ? null : Math.max(clock() + 1000, due);
      const history = desired === null ? this.historyAt : this.historyAt === null ? desired : Math.min(this.historyAt, desired);
      this.historyAt = history;
      if (rideAt !== null && (this.saved.historyAt ?? null) !== history) {
        this.saved.historyAt = history ?? undefined;
        await this.ctx.storage.put('state-v1', this.saved);
      }
      return history;
    }
    private async arm(ridesChanged = false) {
      const collecting = !!this.journal && this.env.HISTORY_COLLECTION === 'enabled', rideAt = this.rideWake();
      if (!this.ctx.storage.getAlarm || !this.ctx.storage.setAlarm) return;
      // Collection off and no ride: no alarm, so nothing polls NJ Transit in the background.
      if (!collecting && rideAt === null) {
        if (ridesChanged && this.ctx.storage.deleteAlarm && await this.ctx.storage.getAlarm() !== null) await this.ctx.storage.deleteAlarm();
        return;
      }
      const history = await this.planHistory(rideAt);
      // A ride check due within one poll before the history run waits for it, so a ride poll never takes
      // the history run's turn at the global pace.
      let next = rideAt;
      if (history !== null) next = rideAt === null || history - Math.max(rideAt, clock()) < POLL_MS ? history : Math.min(history, rideAt);
      if (next !== null) {
        const desired = Math.max(clock() + 1000, next), existing = await this.ctx.storage.getAlarm();
        // Moved later only when rides changed, so an ended ride leaves no early alarm behind.
        if (existing === null || existing > desired || (ridesChanged && existing < desired)) await this.ctx.storage.setAlarm(desired);
      }
    }
    private async poll(background = false, forRides = false) {
      if (!this.pending && clock() - this.saved.pollAt >= (this.journal?.intervalMs(clock()) ?? POLL_MS)) {
        let attempt: number | undefined;
        // A ride's poll never starts a history attempt: collection runs only on its own schedule.
        try { attempt = forRides ? undefined : this.journal?.beginAttempt(clock()); } catch { this.collectionError = true; }
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
      // History runs (collection, archive flush, prune) only at their own due time, exactly as with no ride:
      // an alarm that fired for a ride leaves them alone, and a ride never makes them later. With no ride the
      // alarm is only ever the history alarm (arm moves a ride's leftover alarm when rides change), as before.
      const collect = collecting && (rideAt === null || !this.journal || this.historyAt === null || this.historyAt <= clock());
      try {
        if (collect) {
          this.historyAt = null;
          await this.poll(true);
          if (this.archive) await this.archive.flush(clock());
          this.journal?.pruneVerified(clock());
          // Derived work last, from spare write margin only; it never throws into collection.
          const spare = (units: number, now: number, keep?: number) => this.journal?.reserveSpareWrites(units, now, keep) ?? false;
          try { this.earlier?.fold(clock(), spare); } catch { /* independent derived work */ }
          try { this.confidence?.fold(clock(), spare); } catch { /* counted inside */ }
          try { if (this.archive) await this.backfill?.step(clock(), spare); } catch { /* counted inside */ }
        }
      }
      finally {
        // Ride checks never throw into collection; they piggyback on the poll above when it ran. The next
        // history run is fixed first, so the time a ride's pushes take never moves it, and the rides stop
        // starting new checks once it is due (the rest are checked first at the next alarm).
        if (rideAt !== null) {
          let deadline: number | null = null;
          try { deadline = await this.planHistory(rideAt); } catch { /* arm below retries and throws if storage is failing */ }
          await this.watchRides(deadline);
        }
        // Normal feed failures are persisted gaps. Unexpected storage/alarm errors
        // still throw so the platform's bounded retries remain available.
        await this.arm(rideAt !== null);
      }
    }
    private async watchRides(deadline: number | null) {
      const rides = this.rides;
      if (!rides) return;
      try {
        rides.purge(clock());
        if (rides.activeCount() === 0) return;
        // Within one poll of the history run, the ride waits for that run's poll (see arm) and checks the latest data.
        const now = clock(), history = this.env.HISTORY_COLLECTION === 'enabled' ? this.historyAt : null;
        if (history === null || history <= now || history - now >= POLL_MS) await this.poll(true, true);
        await rides.watch(this.env, deadline);
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
      // Only a switched-on archive saves or counts new responses; a draining one just finishes old work.
      const saving = this.rawSaving ? this.rawArchive : undefined;
      const railDue = !!saving && this.env.RAIL_GTFSRT_RAW === 'enabled' && !rawBudgetPausesRail(this.saved.rawArchive, now);
      if (railDue) startRailBudgetRetry(this.saved.rawArchive, now);
      const rail = railDue ? new RailGtfsrt(this.saved.railGtfsrt ??= newRailGtfsrtState(), this.env, async () => {
        if (!this.journal?.reserveSpareWrites(3, clock())) throw new NjtError('sql-write-budget');
        await this.ctx.storage.put('state-v1', this.saved);
      }, fetchImpl, clock) : undefined;
      const railPlan = rail?.prepare(now);
      const railReason = this.saved.railGtfsrt?.reason;
      if (rail && !railPlan && railReason && ['request-ceiling', 'token-limit', 'configuration-missing'].includes(railReason)) {
        for (const feed of ['rail-getVehiclePositions', 'rail-getTripUpdates'] as const) saving?.recordFailure(feed, railReason, now);
      }
      const needsAuth = !this.saved.token || this.saved.token.expiresAt <= now;
      const authCooldown = needsAuth && now - this.saved.authAt < AUTH_RETRY_MS;
      const busAllowed = !authCooldown && reserveRequests(this.saved.busBudget ??= { hours: {} }, needsAuth ? 3 : 2, now);
      // Persist the pace limit before I/O, so an eviction cannot multiply upstream requests.
      await this.ctx.storage.put('state-v1', this.saved);
      this.saved.failures = { ...this.saved.failures };
      const raw: RawResponse[] = [], rawSecrets = [this.env.NJT_API_USERNAME, this.env.NJT_API_PASSWORD];
      try {
        if (authCooldown) throw new NjtError('authentication-cooldown');
        if (!busAllowed) throw new NjtError('request-ceiling');
        if (!this.saved.token || this.saved.token.expiresAt <= now) {
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
        rawSecrets.push(token);
        const fetchFeed = async (endpoint: 'getVehiclePositions' | 'getTripUpdates', kind: 'vehicles' | 'updates') => {
          // A cooldown is not a new endpoint attempt: retain the last failure until that feed retries.
          delete this.saved.failures![kind];
          if (endpoint === 'getVehiclePositions') this.upstreamVehicleAttempts++;
          try {
            const bytes = await njtRequest(endpoint, { token }, saving ? RAW_RESPONSE_MAX_BYTES : 8 * 1024 * 1024, fetchImpl), receivedAt = clock();
            if (saving && regionRoutes) {
              // Filtering/decoding failure must never replace live data or interrupt corridor history.
              try { raw.push(await filterRegionRaw({ feed: endpoint, bytes, receivedAt }, regionRoutes)); }
              catch { saving.recordFailure(endpoint, 'invalid-response', receivedAt); }
            }
            const feed = normalize(bytes, kind, receivedAt); if (feed.feed.state !== 'invalid') successes++; return feed;
          }
          catch (error) {
            saving?.recordFailure(endpoint, safeNjtFailure(error), clock());
            this.saved.failures![kind] = { code: safeNjtFailure(error), at: now };
            if (error instanceof NjtError && error.code === 'access-denied') denials++;
            return unavailable();
          }
        };
        const [vehicles, updates] = await Promise.all([fetchFeed('getVehiclePositions', 'vehicles'), fetchFeed('getTripUpdates', 'updates')]);
        if (denials > 0 && successes === 0) this.saved.token = undefined;
        this.saved.vehicles = vehicles; this.saved.updates = updates;
      } catch (error) {
        for (const feed of ['getVehiclePositions', 'getTripUpdates'] as const) saving?.recordFailure(feed, safeNjtFailure(error), now);
        // Preserve the original failure throughout authentication cooldown instead of hiding it.
        if (!(error instanceof NjtError && error.code === 'authentication-cooldown' && this.saved.failures.authentication))
          this.saved.failures.authentication = { code: safeNjtFailure(error), at: now };
        this.saved.vehicles = unavailable(); this.saved.updates = unavailable();
      }
      if (rail && railPlan) {
        try {
          const result = await rail.collect(railPlan);
          raw.push(...result.responses); rawSecrets.push(...result.secrets);
          for (const failure of result.failures) saving?.recordFailure(failure.feed, failure.code, failure.at);
        } catch { this.saved.rawArchive!.failures++; }
      }
      if (this.rawArchive) {
        // Raw writes cannot interrupt live buses or normalized corridor evidence.
        try { await this.rawArchive.capture(raw, clock(), rawSecrets); }
        catch { this.saved.rawArchive!.reason = 'archive-error'; this.saved.rawArchive!.failures++; }
      }
      await this.ctx.storage.put('state-v1', this.saved);
    }
    async fetch(request: Request): Promise<Response> {
      if (new URL(request.url).pathname === OWNER_HISTORY_PATH) {
        const denied = await ownerAuthorization(request, this.env.OWNER_HISTORY_SECRET);
        if (denied) return denied;
        const headers = { 'cache-control': 'private, no-store', 'vary': 'Authorization' };
        if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
        const query = ownerQuery(new URL(request.url));
        if (!query) return Response.json({ error: 'Invalid query' }, { status: 400, headers });
        await this.ready;
        if (!this.journal || !this.ctx.storage.sql || !this.ctx.storage.transactionSync) return Response.json({ error: 'history-unavailable' }, { status: 503, headers });
        const bucket = this.env.HISTORY_ARCHIVE as unknown as Partial<ArchiveReader> | undefined;
        return new OwnerHistory(this.ctx.storage as HistoryStorage, typeof bucket?.list === 'function' && typeof bucket.get === 'function' ? bucket as ArchiveReader : undefined)
          .read(query, clock(), (units, at) => this.journal!.reserveReadWrites(units, at, 2500));
      }
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
          alarmAt: await this.ctx.storage.getAlarm?.() ?? null, rawArchive: this.rawStatus(), archive: this.archive?.status(clock()) ?? { configured: !!this.env.HISTORY_ARCHIVE, enabled: false } } : { enabled: false, reason: this.collectionError ? 'storage-unavailable' : 'disabled' }; }
        catch { collection = { enabled: this.env.HISTORY_COLLECTION === 'enabled', reason: 'storage-unavailable', error: true }; }
        return Response.json({ v: 1, collection, rideAlerts: this.rideHealth(), arrivalConfidence: this.confidenceHealth() }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/v1/earlier-buses') {
        if (this.env.EARLIER_BUSES !== 'public') return new Response('Not found', { status: 404 });
        const query = parseEarlierQuery(url.searchParams, ds);
        if (!query) return Response.json({ v: 1, error: 'invalid' }, { status: 400 });
        try {
          const answer = this.earlier?.answer(query, clock());
          if (answer) return Response.json(answer, { headers: { 'cache-control': 'no-store' } });
        } catch { /* unknown stays unknown */ }
        return Response.json({ v: 1, state: 'unavailable' }, { status: 503 });
      }
      // Aggregates only, from SQLite. Never a demand refresh or an NJ Transit request.
      if (url.pathname === '/v1/arrival-confidence') {
        const key = parseConfidenceQuery(url.searchParams, ds);
        if (!key) return Response.json({ v: 1, error: 'invalid' }, { status: 400, headers: { 'cache-control': 'no-store' } });
        try { if (this.confidence) return Response.json(this.confidence.answer(key), { headers: { 'cache-control': 'public, max-age=600' } }); }
        catch { /* unreadable aggregate: unavailable, never a guess */ }
        return Response.json({ v: 1, state: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/v1/rail') {
        return Response.json(await this.rail.board(url.searchParams.get('station')!), { headers: { 'cache-control': 'no-store' } });
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
            alarmAt: await this.ctx.storage.getAlarm?.() ?? null, rawArchive: this.rawStatus(), archive: this.archive?.status(now) ?? { configured: !!this.env.HISTORY_ARCHIVE, enabled: false } };
          else if (this.collectionError) collection = { enabled: false, reason: 'storage-unavailable', error: true };
        } catch { collection = { enabled: this.env.HISTORY_COLLECTION === 'enabled', reason: 'storage-unavailable', error: true }; }
        let rail: unknown = { error: true };
        try { rail = await this.rail.health(); } catch { /* Health never fails on rail storage. */ }
        return Response.json({ v: 1, source: LIVE_SOURCE, feedVersion: ds.meta.feedVersion, collection, rideAlerts: this.rideHealth(), rail,
        connectionFailures: this.saved.failures ?? {},
        vehicles: age(vehicles), updates: age(updates), vehicleDiagnostics: vehicles.diagnostics, updateDiagnostics: updates.diagnostics, reportingBuses: new Set(vehicles.observations.filter((o) => now - o.observedAt <= 120_000).map((o) => o.vehicleId)).size,
        example: vehicles.observations.filter((o) => now - o.observedAt <= 120_000).sort((a, b) => b.observedAt - a.observedAt)[0],
      }, { headers: { 'cache-control': 'no-store' } });
      }
      return Response.json(this.snapshot(trip, date, vehicle, now), { headers: { 'cache-control': 'no-store' } });
    }
    /** Aggregate counts and limits only: never trips, vehicles, stops, samples or archive keys. */
    private confidenceHealth() {
      try { return this.confidence ? { ...this.confidence.status(), backfill: this.backfill?.status() ?? { configured: false } } : { available: false }; }
      catch { return { available: false, error: true }; }
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

export function createRouter(ds: Dataset, rawGeometry?: unknown, rawRescue?: unknown) {
  // Static delivery only: geometry is never passed to the recorder or upstream poller.
  let geometry: string | undefined;
  if (rawGeometry != null) {
    try {
      const text = JSON.stringify(rawGeometry);
      if (new TextEncoder().encode(text).byteLength <= MAX_GEOMETRY_BYTES) geometry = JSON.stringify(parseRouteGeometry(rawGeometry, ds));
    } catch { /* Optional malformed geometry disables distance, never the recorder/router. */ }
  }
  // The wider rescue schedule (#32) is static delivery too: it never reaches the recorder, the
  // upstream poller or the trip checks below, which use the corridor schedule only.
  let rescue: string | undefined;
  if (rawRescue != null) {
    try {
      const text = JSON.stringify(rawRescue);
      if (new TextEncoder().encode(text).byteLength <= RESCUE_SCHEDULE_MAX_BYTES) { parseRescueSchedule(rawRescue, ds); rescue = text; }
    } catch { /* A malformed or mismatched wider schedule is not served; the corridor schedule is unaffected. */ }
  }
  const schedule = JSON.stringify(ds), trips = new Map(ds.trips.map((t) => [t.id, t]));
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const origin = request.headers.get('origin'), url = new URL(request.url);
      const headers = new Headers({ 'access-control-allow-origin': 'https://jwchr.github.io', 'vary': 'Origin', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      const reply = (body: string | null, status = 200) => new Response(body, { status, headers });
      if (url.pathname === OWNER_HISTORY_PATH) {
        // Owner scripts only: no browser CORS grant, token URL, demand poll or public caching.
        const denied = await ownerAuthorization(request, env.OWNER_HISTORY_SECRET);
        if (denied) return denied;
        const privateHeaders = { 'cache-control': 'private, no-store', 'vary': 'Authorization', 'x-content-type-options': 'nosniff' };
        if (origin) return Response.json({ error: 'Origin not allowed' }, { status: 403, headers: privateHeaders });
        if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: privateHeaders });
        if (!ownerQuery(url)) return Response.json({ error: 'Invalid query' }, { status: 400, headers: privateHeaders });
        try {
          const response = await env.FEED.get(env.FEED.idFromName('corridor-v1')).fetch(new Request(request.url, { headers: { authorization: request.headers.get('authorization')! } }));
          return new Response(response.body, { status: response.status, headers: { ...privateHeaders, 'content-type': 'application/json' } });
        } catch { return Response.json({ error: 'History unavailable' }, { status: 503, headers: privateHeaders }); }
      }
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
      if (url.pathname === '/v1/schedule' && url.searchParams.has('extra')) {
        if (url.searchParams.get('extra') !== 'rescue') return reply('Not found', 404);
        if (url.searchParams.get('feedVersion') !== ds.meta.feedVersion) return reply('Feed mismatch', 409);
        if (!rescue) return reply('Rescue schedule unavailable', 404);
        headers.set('content-type', 'application/json');
        headers.set('cache-control', 'public, max-age=300');
        return reply(rescue);
      }
      if (url.pathname === '/v1/schedule') { headers.set('content-type', 'application/json'); return reply(schedule); }
      if (url.pathname === '/v1/geometry') {
        if (url.searchParams.get('feedVersion') !== ds.meta.feedVersion) return reply('Feed mismatch', 409);
        if (!geometry) return reply('Geometry unavailable', 404);
        headers.set('content-type', 'application/json');
        headers.set('cache-control', 'public, max-age=300');
        return reply(geometry);
      }
      if (url.pathname === '/v1/earlier-buses') {
        if (env.EARLIER_BUSES !== 'public') return reply('Not found', 404);
        if (request.url.length > 512 || !parseEarlierQuery(url.searchParams, ds)) return reply('Invalid earlier buses query', 400);
        try {
          const response = await env.FEED.get(env.FEED.idFromName('corridor-v1')).fetch(request);
          headers.set('content-type', 'application/json');
          return reply(await response.text(), response.status);
        } catch { return reply('Earlier buses unavailable', 503); }
      }
      if (url.pathname === '/v1/arrival-confidence') {
        // Read-only aggregates (docs/ARRIVAL_CONFIDENCE.md). Strict input; no upstream call is possible on this path.
        // Off until the owner decides the NJ Transit terms question; aggregates still build privately.
        if (env.ARRIVAL_CONFIDENCE !== 'public') return reply('Not found', 404);
        if (request.url.length > 512 || !parseConfidenceQuery(url.searchParams, ds)) return reply('Invalid arrival confidence query', 400);
        try {
          const response = await env.FEED.get(env.FEED.idFromName('corridor-v1')).fetch(request);
          headers.set('content-type', 'application/json');
          if (response.status === 200) headers.set('cache-control', 'public, max-age=600');
          return reply(await response.text(), response.status);
        } catch { return reply('Arrival confidence unavailable', 503); }
      }
      if (!['/v1/live', '/v1/status', '/v1/departures', '/v1/collection', '/v1/rail'].includes(url.pathname)) return reply('Not found', 404);
      if (url.pathname === '/v1/rail') {
        const station = url.searchParams.get('station');
        if (!station || !Object.hasOwn(RAIL_STATIONS, station) || [...url.searchParams.keys()].length !== 1) return reply('Invalid station', 400);
      }
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
