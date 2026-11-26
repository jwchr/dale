import { njtRequest, NjtError, RAW_RESPONSE_MAX_BYTES, safeNjtFailure, type Credentials } from './njt-client';
import { HISTORY_INTERVAL_MS } from './history-journal';
import { reserveRequests, type RequestBudget } from './request-budget';
import type { RawResponse, RawFeed } from './raw-archive';

const DAY = 86400_000, HOUR = 3600_000;
// Leave room below NJT's 10 token calls/day for separate operator checks. No isValidToken calls.
export const RAIL_GTFSRT_MINT_LIMIT = 3;
export interface RailGtfsrtState {
  token?: { value: string; at: number }; mints: number[]; budget: RequestBudget;
  pollAt?: number; pausedUntil?: number; reason?: string;
}
export const newRailGtfsrtState = (): RailGtfsrtState => ({ mints: [], budget: { hours: {} } });
export interface RailPlan { token?: string; mint: boolean }
export interface RailRawFailure { feed: RawFeed; code: string; at: number }

/** GTFS-RT has its own token, never a TrainData token. The relay persists prepare()
 * before any I/O and saves a new token before using it. No RailData background calls. */
export class RailGtfsrt {
  constructor(private state: RailGtfsrtState, private env: Credentials, private checkpoint: () => Promise<void>,
    private fetchImpl: typeof fetch = fetch, private clock = Date.now) {}

  prepare(now: number): RailPlan | undefined {
    const s = this.state;
    if (now < (s.pausedUntil ?? 0) || (s.pollAt !== undefined && now - s.pollAt < HISTORY_INTERVAL_MS)) return;
    if (!this.env.NJT_API_USERNAME?.trim() || !this.env.NJT_API_PASSWORD?.trim()) { s.reason = 'configuration-missing'; return; }
    const token = s.token && now >= s.token.at && now - s.token.at < 23 * HOUR ? s.token.value : undefined;
    s.mints = s.mints.filter(at => now - at < DAY);
    if (!token && (s.mints.length >= RAIL_GTFSRT_MINT_LIMIT || s.mints.some(at => now - at < HOUR))) { s.reason = 'token-limit'; return; }
    if (!reserveRequests(s.budget, token ? 3 : 4, now)) { s.reason = 'request-ceiling'; return; }
    s.pollAt = now;
    if (!token) s.mints.push(now);
    return { token, mint: !token };
  }

  async collect(plan: RailPlan): Promise<{ responses: RawResponse[]; failures: RailRawFailure[]; secrets: string[] }> {
    const result: { responses: RawResponse[]; failures: RailRawFailure[]; secrets: string[] } = { responses: [], failures: [], secrets: [] };
    const methods = ['getVehiclePositions', 'getTripUpdates', 'getAlerts'] as const;
    const request = (method: 'getToken' | typeof methods[number], fields: Record<string, string>, max: number) =>
      njtRequest(method, fields, max, this.fetchImpl, 15_000, 'rail-gtfsrt');
    let token = plan.token;
    if (token) result.secrets.push(token);
    try {
      if (plan.mint) {
        const bytes = await request('getToken', { username: this.env.NJT_API_USERNAME, password: this.env.NJT_API_PASSWORD }, 16_384);
        let value;
        try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new NjtError('invalid-response'); }
        if (String(value?.Authenticated).toLowerCase() !== 'true' || typeof value?.UserToken !== 'string' || !value.UserToken.trim()) throw new NjtError('access-denied');
        token = value.UserToken.trim();
        result.secrets.push(token!);
        this.state.token = { value: token!, at: this.clock() };
        await this.checkpoint();
      }
      if (!token) throw new NjtError('invalid-token');
    } catch (error) {
      this.state.reason = safeNjtFailure(error);
      for (const method of methods) result.failures.push({ feed: `rail-${method}`, code: this.state.reason, at: this.clock() });
      return result;
    }
    let denied = false;
    await Promise.all(methods.map(async method => {
      try {
        const bytes = await request(method, { token }, RAW_RESPONSE_MAX_BYTES);
        // The guide also documents HTTP-200 JSON error bodies. Never archive those as protobuf.
        if (bytes.byteLength <= 16_384 && new TextDecoder().decode(bytes.subarray(0, 32)).trimStart().startsWith('{')) {
          let errorMessage: unknown;
          try { errorMessage = JSON.parse(new TextDecoder().decode(bytes))?.errorMessage; } catch { /* Preserve malformed data as received. */ }
          if (typeof errorMessage === 'string') throw new NjtError(/invalid token/i.test(errorMessage) ? 'access-denied' : /daily usage limit/i.test(errorMessage) ? 'rate-limited' : 'invalid-response');
        }
        result.responses.push({ feed: `rail-${method}`, bytes, receivedAt: this.clock() });
      } catch (error) {
        const code = safeNjtFailure(error);
        denied ||= code === 'access-denied';
        if (code === 'rate-limited') this.state.pausedUntil = this.clock() + 15 * 60_000;
        result.failures.push({ feed: `rail-${method}`, code, at: this.clock() });
      }
    }));
    if (denied && !result.responses.length) this.state.token = undefined;
    this.state.reason = result.failures[0]?.code ?? 'ready';
    return result;
  }
}
