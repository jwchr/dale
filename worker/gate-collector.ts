import type { Dataset } from '../src/domain/types';
import { localYmd } from '../src/domain/time';
import { authenticateBusDv, njtRequest, NjtError, safeNjtFailure, type Credentials } from './njt-client';
import { gateCandidates, GATE_MAX_AGE_MS, matchGateRows, newGateDiagnostics, parseDvResponse, type GateDiagnostics, type Posting } from './gates';

interface RouteState { lastAttemptAt?: number; lastSuccessAt?: number; state: 'ready' | 'empty' | 'unavailable' | 'quota-paused'; reason?: string; postings: Posting[]; diagnostics: GateDiagnostics }
/** Only the BUSDV2 token and its failed-auth cooldown are durable. Postings expire in 120 s and stay in memory. */
export interface GateAuthState { token?: { value: string; expiresAt: number }; authAt?: number }
interface GateStorage { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }
/** Requests reserved durably in one write and spent from memory, so a gate poll costs no storage write per request.
 * Unspent credit is lost on restart, which only makes the rolling ceiling more conservative. */
const LEASE = 40;
/** A helper of the corridor alarm, never a collector/alarm of its own. */
export class GateCollector {
  private routes: Record<string, RouteState> = {};
  private auth: GateAuthState = {};
  private credit = 0;
  private pending?: Promise<void>;
  constructor(private ds: Dataset, private storage: GateStorage, private env: Credentials & { LIVE_GATES?: string },
    private reserve: (count: number, now: number) => Promise<boolean>, private fetchImpl: typeof fetch, private clock: () => number,
    private spare: () => boolean = () => true) {}
  async load() {
    const saved = await this.storage.get<GateAuthState>('gates-v1');
    if (saved) this.auth = { token: saved.token, authAt: saved.authAt };
  }
  private async saveAuth() {
    if (!this.spare()) throw new NjtError('sql-write-budget');
    await this.storage.put('gates-v1', this.auth);
  }
  /** Spend reserved credit; reserve a lease (or just what is needed, near the ceiling) before any network I/O. */
  private async take(count: number, now: number): Promise<boolean> {
    if (this.credit < count) {
      const lease = Math.max(count, LEASE);
      if (await this.reserve(lease, now)) this.credit += lease;
      else if (lease > count && await this.reserve(count, now)) this.credit += count;
      else return false;
    }
    this.credit -= count;
    return true;
  }
  poll(): Promise<void> {
    if (this.env.LIVE_GATES !== 'enabled') return Promise.resolve();
    return this.pending ??= this.collect().finally(() => { this.pending = undefined; });
  }
  private async collect() {
    const startedAt = this.clock(), candidates = gateCandidates(this.ds, startedAt);
    const routes = [...new Set(candidates.filter(c => c.at >= startedAt && c.at < startedAt + 3600_000).map(c => c.route))].sort();
    for (const route of routes) {
      const now = this.clock();
      if (!candidates.some(c => c.route === route && c.at >= now && c.at < now + 3600_000)) continue;
      const r = this.routes[route] ??= { state: 'unavailable', postings: [], diagnostics: newGateDiagnostics(now) };
      // A clock that moved backwards also waits (negative difference).
      if (r.lastAttemptAt !== undefined && now - r.lastAttemptAt < 60_000) continue;
      r.lastAttemptAt = now;
      if (r.diagnostics.day !== localYmd(now, 'America/New_York')) r.diagnostics = newGateDiagnostics(now);
      const needsAuth = !this.auth.token || this.auth.token.expiresAt <= now;
      try {
        if (needsAuth && this.auth.authAt !== undefined && now - this.auth.authAt < 3600_000) throw new NjtError('authentication-cooldown');
        if (!await this.take(needsAuth ? 2 : 1, now)) throw new NjtError('request-ceiling');
        if (needsAuth) {
          // The cooldown is durable before the attempt, so a restart cannot retry authentication sooner.
          this.auth.authAt = now; await this.saveAuth();
          this.auth.token = { value: await authenticateBusDv(this.env, this.fetchImpl), expiresAt: now + 20 * 3600_000 };
          // Slow authentication must not shorten this route's next board-request interval.
          r.lastAttemptAt = this.clock();
          try { await this.saveAuth(); } catch { /* the token still works from memory; a restart waits out the cooldown */ }
        }
        const bytes = await njtRequest('getBusDV', { token: this.auth.token!.value, stop: 'PABT', route, direction: '', minutesRequested: '60' }, 256 * 1024, this.fetchImpl, 15_000, 'bus-dv');
        const receivedAt = this.clock(), rows = parseDvResponse(bytes);
        // No overlapping poll can overwrite newer evidence; backwards clocks fail closed too.
        if (receivedAt < now || (r.lastSuccessAt !== undefined && receivedAt < r.lastSuccessAt)) continue;
        const postings = matchGateRows(rows, candidates.filter(c => c.route === route), receivedAt, r.diagnostics);
        r.postings = postings; r.lastSuccessAt = receivedAt; r.state = postings.length ? 'ready' : 'empty'; delete r.reason;
      } catch (error) {
        r.reason = safeNjtFailure(error); r.state = r.reason === 'request-ceiling' ? 'quota-paused' : 'unavailable';
        if (r.reason === 'access-denied' && this.auth.token) {
          // Forget the rejected token durably too, so a restart does not reuse it (Flash review #296).
          this.auth.token = undefined;
          try { await this.saveAuth(); } catch { /* memory is already clear; a restart spends one rejected call at most */ }
        }
      }
    }
  }
  answer() {
    if (this.env.LIVE_GATES !== 'enabled') return { v: 1, available: false };
    const now = this.clock(), day = localYmd(now, 'America/New_York');
    const routes = [...new Set(this.ds.patterns.filter(p => p.stopIds.some(id => this.ds.stops.some(s => s.id === id && s.terminal === 'PABT'))).map(p => this.ds.routes.find(r => r.id === p.routeId)?.shortName).filter((r): r is string => !!r))].sort();
    return { v: 1, schemaVersion: 1, feedVersion: this.ds.meta.feedVersion, generatedAt: now,
      routes: routes.map(route => {
        const r = this.routes[route];
        const stale = r?.lastSuccessAt !== undefined && (now < r.lastSuccessAt || now - r.lastSuccessAt >= GATE_MAX_AGE_MS);
        return { route, state: stale && (r?.state === 'ready' || r?.state === 'empty') ? 'stale' : r?.state ?? 'unavailable', lastSuccessAt: r?.lastSuccessAt, lastAttemptAt: r?.lastAttemptAt };
      }),
      postings: Object.values(this.routes).flatMap(r => r.postings.flatMap(p => {
        const ageMs = now - p.receivedAt;
        if (ageMs < 0 || ageMs >= GATE_MAX_AGE_MS) return [];
        return [{ tripInstanceId: p.tripInstanceId, boardingIndex: p.boardingIndex, gate: p.gate, ...(p.door ? { door: p.door } : {}), source: p.source, ageMs }];
      })),
      diagnostics: Object.fromEntries(routes.map(route => {
        const r = this.routes[route];
        return [route, { ...(r?.diagnostics.day === day ? r.diagnostics : newGateDiagnostics(now)), ...(r?.reason ? { failure: r.reason } : {}) }];
      })),
    };
  }
  health() {
    const answer = this.answer();
    return { enabled: this.env.LIVE_GATES === 'enabled', feedVersion: this.ds.meta.feedVersion, routes: answer.routes, postings: answer.postings?.length ?? 0 };
  }
}
