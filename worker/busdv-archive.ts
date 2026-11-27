import { HISTORY_INTERVAL_MS } from './history-journal';
import { NjtError, type Credentials } from './njt-client';
import { reserveRequests, type RequestBudget } from './request-budget';
import type { RawResponse } from './raw-archive';
import { ARCHIVE_CONNECTIONS, ARCHIVE_START_MS, ARCHIVE_TURN_MS, inPool, looksLikeJson } from './pool';

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const BUSDV_REQUEST_LIMIT = 30_000;
export const VEHICLE_MODES = ['BUS', 'NLR', 'HBLR', 'RL'] as const;
// NJ Transit does not say what unit the radius is in. Live on Nov 26, 2026 (6:43 pm Eastern) a radius of 200
// returned 0 vehicles in every mode while service was running, so it is likely feet. 528,000 is 100 miles in
// feet and reaches Cape May (about 89 miles) and High Point (about 77 miles) from the center; read as meters,
// miles or km it reaches even farther. /v1/collection busDvCoverage shows whether it really covers the state.
export const STATEWIDE_RADIUS = '528000';
export const BUSDV_FEEDS = ['busdv-poll', 'busdv-getLocations', 'busdv-getBusRoutes'] as const;
const BOARD_TARGET_MS = 15 * 60_000, TOKEN_AGE_MS = 23 * HOUR;
const BOARD_MAX_BYTES = 2 * 1024 * 1024, OTHER_MAX_BYTES = 8 * 1024 * 1024;
const ERROR_MAX_BYTES = 16 * 1024;
type Mode = typeof VEHICLE_MODES[number];
type Method = 'authenticateUser' | 'getVehicleLocations' | 'getBusDV' | 'getLocations' | 'getBusRoutes';
type DailyMethod = 'getLocations' | 'getBusRoutes';
type DailyKey = `${DailyMethod}:${Mode}`;
export type BusDvFailureCode = 'configuration-missing' | 'token-limit' | 'access-denied' | 'rate-limited'
  | 'http-error' | 'response-too-large' | 'timed-out' | 'network-error' | 'invalid-response' | 'request-ceiling';
const CODES: readonly string[] = ['configuration-missing', 'token-limit', 'access-denied', 'rate-limited',
  'http-error', 'response-too-large', 'timed-out', 'network-error', 'invalid-response', 'request-ceiling'];
const failureCode = (error: unknown): BusDvFailureCode => error instanceof NjtError && CODES.includes(error.code)
  ? error.code as BusDvFailureCode : 'network-error';

export interface BusDvState {
  budget: RequestBudget; cursor: number; locations?: string[];
  tried: Partial<Record<DailyKey, number>>; ok: Partial<Record<DailyKey, number>>;
  lastPollAt?: number; boardFraction: number; mints: number[]; pauseUntil?: number;
  /** Private caller checkpoint only. Never pass this state to the raw archive or a public endpoint. */
  token?: { value: string; mintedAt: number };
  sequence: number; pending?: number; reason?: string;
  /** Aggregate counts only (no vehicle IDs or exact positions), safe for the public status page. */
  coverage?: Partial<Record<Mode, BusDvCoverage>>;
}
/** How far one mode's last good vehicle answer reached: shows whether the statewide radius covers the state. */
export interface BusDvCoverage {
  at: number; vehicles: number; maxMiles: number | null;
  /** Rounded outward to 0.1 degree (about 11 km), so no exact vehicle position is published. */
  lat: [number, number] | null; lon: [number, number] | null;
}
export const newBusDvState = (): BusDvState => ({ budget: { hours: {} }, cursor: 0,
  tried: {}, ok: {}, boardFraction: 0, mints: [], sequence: 0 });
interface Request { method: Exclude<Method, 'authenticateUser'>; mode?: Mode; stop?: string }
export interface BusDvPlan { id: number; at: number; mint: boolean; requests: Request[]; refusal?: BusDvFailureCode }
export interface BusDvFailure {
  feed: `busdv-${Method}` | 'busdv-poll'; code: BusDvFailureCode; at: number; mode?: Mode; stop?: string;
}
type LocalResponse = Omit<RawResponse, 'feed'> & { feed: typeof BUSDV_FEEDS[number]; label?: Mode };
/** RawFeed integration is deliberately confined to the return boundary until its union is extended. */
export type BusDvResponse = RawResponse;
interface Entry extends Request { receivedAt: number; status: 'ok' | BusDvFailureCode; text?: string; base64?: string }
const encode = (text: string) => new TextEncoder().encode(text);

const coord = (v: unknown, lo: number, hi: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
};
/** Counts and outward-rounded extents of a getVehicleLocations answer; undefined unless it is a JSON array. */
export function busDvCoverage(bytes: Uint8Array): Omit<BusDvCoverage, 'at'> | undefined {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, '')); } catch { return; }
  if (!Array.isArray(value)) return;
  let vehicles = 0, maxMiles: number | null = null, lat: [number, number] | null = null, lon: [number, number] | null = null;
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    // Only rows that look like a vehicle count, so an error or note row does not raise the total (Neon Nov27 a).
    if (!('VehicleLat' in r || 'VehicleLong' in r || 'VehicleDistanceMiles' in r)) continue;
    vehicles++;
    const miles = coord(r.VehicleDistanceMiles, 0, 10_000), y = coord(r.VehicleLat, -90, 90), x = coord(r.VehicleLong, -180, 180);
    if (miles !== undefined) maxMiles = Math.max(maxMiles ?? 0, Math.ceil(miles));
    // 0,0 is a GPS with no fix, not a place in New Jersey, so it never widens the reach (Neon Nov27 a).
    if (y !== undefined && x !== undefined && !(y === 0 && x === 0)) {
      lat = [Math.min(lat?.[0] ?? Infinity, Math.floor(y * 10) / 10), Math.max(lat?.[1] ?? -Infinity, Math.ceil(y * 10) / 10)];
      lon = [Math.min(lon?.[0] ?? Infinity, Math.floor(x * 10) / 10), Math.max(lon?.[1] ?? -Infinity, Math.ceil(x * 10) / 10)];
    }
  }
  return { vehicles, maxMiles, lat, lon };
}
/** Totals for the public status page: counts and reach only, never the private state (it holds the token)
 *  and no map box, since anything public shows totals only (AGENTS.md; CodeRabbit, #324). */
export const busDvCoverageStatus = (state: BusDvState | undefined) => state?.coverage
  ? Object.fromEntries(Object.entries(state.coverage).map(([mode, c]) => [mode, { at: c!.at, vehicles: c!.vehicles, maxMiles: c!.maxMiles }])) as Partial<Record<Mode, Pick<BusDvCoverage, 'at' | 'vehicles' | 'maxMiles'>>>
  : null;

/** A bad or partially malformed list must not silently remove previously discovered boards. */
export function busDvLocationCodes(bytes: Uint8Array): string[] | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(value) || !value.length) return;
    const codes: string[] = [];
    for (const row of value) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return;
      const code: unknown = (row as Record<string, unknown>).bus_terminal_code;
      // The swagger defines a string, with no documented alphabet or length restriction.
      if (typeof code !== 'string' || !code.trim()) return;
      codes.push(code.trim());
    }
    return [...new Set(codes)].sort();
  } catch { return; }
}

function preserve(bytes: Uint8Array): Pick<Entry, 'text' | 'base64'> {
  // ignoreBOM retains an initial UTF-8 BOM, allowing exact byte reconstruction.
  try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; }
  catch {
    let binary = '';
    for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
    return { base64: btoa(binary) };
  }
}

export function containsSecret(bytes: Uint8Array, secrets: string[]): boolean {
  return secrets.filter(Boolean).some(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]
    .some(value => {
      const needle = encode(value);
      for (let at = bytes.indexOf(needle[0]!); at >= 0 && at + needle.length <= bytes.length; at = bytes.indexOf(needle[0]!, at + 1)) {
        if (needle.every((n, i) => bytes[at + i] === n)) return true;
      }
      return false;
    }));
}

/** Error envelopes are small JSON objects/strings, not legitimate board message objects or arrays. */
function errorBody(bytes: Uint8Array): BusDvFailureCode | undefined {
  if (bytes.length > ERROR_MAX_BYTES) return;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return; }
  if (Array.isArray(value) || value === null) return;
  const row = typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const message = typeof value === 'string' ? value : row
    ? [row.errorMessage, row.ErrorMessage, row.error, row.Error, row.message, row.Message].filter(v => typeof v === 'string').join(' ') : '';
  if (/rate.?limit|usage.?limit|daily.?limit|too many requests|quota|40000/i.test(message)) return 'rate-limited';
  if (/invalid\s+token|token.*expir|expir.*token|access.?denied|unauthori[sz]ed|invalid.*credential|authenticat\w*\s+fail/i.test(message)) return 'access-denied';
  // Any other filled-in error field is an unreadable answer. Only an auth message drops the token: a false
  // drop spends one of three daily mints, and the third locks BUSDV2 saving out for a day (Neon, #304).
  // An empty or null error field is not an error.
  if (row && ['errorMessage', 'ErrorMessage', 'error', 'Error'].some(key => row[key] !== undefined && row[key] !== null && row[key] !== '' && row[key] !== false)) return 'invalid-response';
}

/** Only the official BUSDV2 host and statically enumerated methods can be reached. */
async function request(method: Method, fields: Record<string, string>, maxBytes: number,
  fetchImpl: typeof fetch, timeoutMs: number): Promise<Uint8Array<ArrayBuffer>> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    const response = await fetchImpl(`https://pcsdata.njtransit.com/api/BUSDV2/${method}`, {
      method: 'POST', body, redirect: 'manual', cache: 'no-store', signal: ctl.signal,
    });
    if (ctl.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new NjtError('timed-out');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new NjtError(response.status === 401 || response.status === 403 ? 'access-denied'
        : response.status === 429 ? 'rate-limited' : 'http-error');
    }
    if (!response.body) throw new NjtError('invalid-response');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    const cancel = () => { void reader.cancel().catch(() => {}); };
    ctl.signal.addEventListener('abort', cancel, { once: true });
    let size = 0;
    try {
      while (true) {
        if (ctl.signal.aborted) throw new NjtError('timed-out');
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { cancel(); throw new NjtError('response-too-large'); }
        chunks.push(value);
      }
    } finally { ctl.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    if (ctl.signal.aborted) throw new NjtError('timed-out');
    if (!size) throw new NjtError('invalid-response');
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    const code = errorBody(bytes);
    if (code) throw new NjtError(code);
    if (!looksLikeJson(bytes)) throw new NjtError('invalid-response');
    return bytes;
  };
  try {
    // The race also bounds injected fetches/readers that ignore AbortSignal.
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { ctl.abort(); reject(new NjtError('timed-out')); }, timeoutMs);
    })]);
  } catch (error) {
    throw error instanceof NjtError ? error : new NjtError(ctl.signal.aborted ? 'timed-out' : 'network-error');
  } finally { clearTimeout(timer); ctl.abort(); }
}

export class BusDvArchive {
  private collecting = false;
  constructor(private state: BusDvState, private credentials: Credentials,
    private fetchImpl: typeof fetch = fetch, private clock = Date.now, private timeoutMs = 20_000) {}

  /** No I/O here. Persist the private state after prepare and before collect. Requests, token
   * attempts, daily retries and cursor movement are spent even if the process dies before I/O. */
  prepare(now: number): BusDvPlan | 'request-ceiling' | undefined {
    const s = this.state;
    if (!Number.isFinite(now) || now < 0 || now < (s.lastPollAt ?? -Infinity) || this.collecting) return;
    const refusal = (code: BusDvFailureCode): BusDvPlan => {
      s.reason = code;
      return { id: s.pending = ++s.sequence, at: now, mint: false, requests: [], refusal: code };
    };
    if (now < (s.pauseUntil ?? 0)) return refusal('rate-limited');
    if (!this.credentials.NJT_API_USERNAME?.trim() || !this.credentials.NJT_API_PASSWORD?.trim()) return refusal('configuration-missing');
    if (now - (s.lastPollAt ?? -Infinity) < HISTORY_INTERVAL_MS) return;
    const mint = !s.token || now - s.token.mintedAt >= TOKEN_AGE_MS || now < s.token.mintedAt;
    s.mints = s.mints.filter(at => at > now - DAY);
    // Three logins a day. One refused token re-logs in at once, but the last login waits an hour after
    // the one before it, so a short outage cannot spend all three in a minute (Neon DEEP Nov 26).
    if (mint && (s.mints.length >= 3 || (s.mints.length >= 2 && s.mints.some(at => now - at < HOUR)))) return refusal('token-limit');

    const hour = Math.floor(now / HOUR), oldest = Math.floor((now - DAY) / HOUR);
    for (const key of Object.keys(s.budget.hours)) if (Number(key) < oldest) delete s.budget.hours[key];
    const counts = Object.values(s.budget.hours);
    if (counts.some(n => !Number.isSafeInteger(n) || n < 0)) return s.reason = 'request-ceiling';
    const remaining = BUSDV_REQUEST_LIMIT - counts.reduce((a, b) => a + b, 0);
    const requests: Request[] = VEHICLE_MODES.map(mode => ({ method: 'getVehicleLocations', mode }));
    for (const method of ['getLocations', 'getBusRoutes'] as const) for (const mode of VEHICLE_MODES) {
      const key: DailyKey = `${method}:${mode}`;
      if (now - (s.ok[key] ?? -Infinity) >= DAY && now - (s.tried[key] ?? -Infinity) >= HOUR) requests.push({ method, mode });
    }
    const mandatory = requests.length + Number(mint);
    if (remaining < mandatory) return s.reason = 'request-ceiling';

    // reserveRequests retains the entire oldest hour. Pace to its actual expiry, up to 25 h,
    // rather than midnight. Hold vehicles at the fastest legal cadence, hourly daily-call
    // retries, and three mints ahead of boards. The remainder determines the board share.
    const firstHour = Math.min(hour, ...Object.keys(s.budget.hours).map(Number));
    const horizon = Math.max(HISTORY_INTERVAL_MS, (firstHour + 25) * HOUR - now);
    const futureVehicles = VEHICLE_MODES.length * Math.ceil(horizon / HISTORY_INTERVAL_MS);
    const futureDaily = 2 * VEHICLE_MODES.length * Math.ceil(horizon / HOUR);
    const boardShare = Math.max(0, remaining - futureVehicles - futureDaily - 3);
    const spacing = Math.min(45_000, Math.max(HISTORY_INTERVAL_MS, now - (s.lastPollAt ?? now - HISTORY_INTERVAL_MS)));
    const credit = boardShare * spacing / horizon + s.boardFraction;
    const locations = s.locations?.length ? s.locations : ['PABT'];
    const boardCount = Math.min(locations.length, Math.ceil(locations.length * spacing / BOARD_TARGET_MS),
      Math.floor(credit), remaining - mandatory);
    const cursor = s.cursor % locations.length;
    for (let n = 0; n < boardCount; n++) requests.push({ method: 'getBusDV', stop: locations[(cursor + n) % locations.length]! });
    // The existing helper has a fixed 40,000 ceiling; the stricter check above is local.
    if (!reserveRequests(s.budget, requests.length + Number(mint), now)) return s.reason = 'request-ceiling';
    s.boardFraction = credit - Math.floor(credit);
    s.cursor = (cursor + boardCount) % locations.length;
    s.lastPollAt = now;
    if (mint) s.mints.push(now);
    for (const r of requests) if (r.method === 'getLocations' || r.method === 'getBusRoutes') s.tried[`${r.method}:${r.mode!}`] = now;
    return { id: s.pending = ++s.sequence, at: now, mint, requests };
  }

  async collect(plan: BusDvPlan): Promise<{ responses: BusDvResponse[]; failures: BusDvFailure[]; secrets: string[] }> {
    const s = this.state, responses: LocalResponse[] = [], failures: BusDvFailure[] = [], entries: Entry[] = [];
    const secrets = new Set([this.credentials.NJT_API_USERNAME, this.credentials.NJT_API_PASSWORD, s.token?.value ?? ''].filter(Boolean));
    const finish = () => ({ responses: responses as unknown as BusDvResponse[], failures, secrets: [...secrets] });
    const fail = (r: Request | undefined, code: BusDvFailureCode, updateState = true) => {
      failures.push({ feed: r ? `busdv-${r.method}` : 'busdv-poll', code, at: this.clock(),
        ...(r?.mode ? { mode: r.mode } : {}), ...(r?.stop ? { stop: r.stop } : {}) });
      if (r) entries.push({ ...r, receivedAt: this.clock(), status: code });
      if (updateState && code === 'access-denied') delete s.token;
      if (updateState && code === 'rate-limited') s.pauseUntil = Math.max(s.pauseUntil ?? 0, this.clock() + HOUR);
    };
    if (s.pending !== plan.id || this.collecting) { fail(undefined, 'invalid-response'); return finish(); }
    delete s.pending;
    if (plan.refusal) { fail(undefined, plan.refusal, false); return finish(); }
    if (this.clock() < (s.pauseUntil ?? 0)) { fail(undefined, 'rate-limited', false); return finish(); }
    this.collecting = true;
    const started = this.clock();
    try {
      let authFailure: BusDvFailureCode | undefined;
      if (plan.mint) {
        delete s.token;
        try {
          const bytes = await request('authenticateUser', { username: this.credentials.NJT_API_USERNAME,
            password: this.credentials.NJT_API_PASSWORD }, ERROR_MAX_BYTES, this.fetchImpl, this.timeoutMs);
          let value: { Authenticated?: unknown; UserToken?: unknown };
          try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
          catch { throw new NjtError('invalid-response'); }
          if (!value || String(value.Authenticated).toLowerCase() !== 'true') throw new NjtError('access-denied');
          if (typeof value.UserToken !== 'string' || !value.UserToken.trim()) throw new NjtError('invalid-response');
          s.token = { value: value.UserToken, mintedAt: this.clock() };
          secrets.add(value.UserToken);
        } catch (error) { authFailure = failureCode(error); fail(undefined, authFailure); }
      }
      const token = s.token?.value;
      if (!token && !authFailure) authFailure = 'access-denied';
      // All data calls use the same captured token. In-flight siblings still finish on a refusal;
      // nothing retries inside this poll, and a rate limit blocks every subsequent poll for 1 h.
      // Two at a time: RailData takes two more, leaving rail GTFS-RT and R2 the rest of the Worker's 6.
      await inPool(plan.requests, ARCHIVE_CONNECTIONS, async r => {
        if (authFailure || !token) { fail(r, authFailure ?? 'access-denied'); return; }
        // A rate limit from a sibling stops the rest of this poll too (Neon, #304).
        if (this.clock() < (s.pauseUntil ?? 0)) { fail(r, 'rate-limited', false); return; }
        // The live bus poll waits for this turn, so a slow NJ Transit answer cannot hold it (Neon, #304):
        // nothing starts after ARCHIVE_START_MS, and nothing runs past ARCHIVE_TURN_MS.
        const elapsed = this.clock() - started;
        if (elapsed >= ARCHIVE_START_MS) { fail(r, 'timed-out', false); return; }
        const fields: Record<string, string> = { token };
        if (r.mode) fields.mode = r.mode;
        if (r.method === 'getVehicleLocations') Object.assign(fields, { lat: '40.2', lon: '-74.6', radius: STATEWIDE_RADIUS });
        // Blank means all; not checked against a live answer.
        if (r.method === 'getBusDV') Object.assign(fields, { stop: r.stop!, direction: '', route: '', IP: '', minutesRequested: '', maxVariants: '', sortMode: '' });
        try {
          const bytes = await request(r.method, fields, r.method === 'getBusDV' ? BOARD_MAX_BYTES : OTHER_MAX_BYTES,
            this.fetchImpl, Math.min(this.timeoutMs, ARCHIVE_TURN_MS - elapsed));
          if (containsSecret(bytes, [...secrets])) throw new NjtError('invalid-response');
          const receivedAt = this.clock();
          if (r.method === 'getLocations' || r.method === 'getBusRoutes') {
            const response: LocalResponse = { feed: `busdv-${r.method}`, label: r.mode!, bytes, receivedAt };
            responses.push(response);
            let valid = true;
            if (r.method === 'getLocations' && r.mode === 'BUS') {
              const codes = busDvLocationCodes(bytes);
              if (codes) s.locations = codes;
              else {
                valid = false;
                failures.push({ feed: 'busdv-getLocations', mode: 'BUS', code: 'invalid-response', at: receivedAt });
              }
            }
            // Done only once the raw archive has the answer, so one it could not take is asked again in an
            // hour (CodeRabbit, #324; see RawResponse.onAccepted).
            const step = `${r.method}:${r.mode!}` as const;
            if (valid) response.onAccepted = () => { s.ok[step] = receivedAt; };
          } else {
            entries.push({ ...r, receivedAt, status: 'ok', ...preserve(bytes) });
            const coverage = r.method === 'getVehicleLocations' ? busDvCoverage(bytes) : undefined;
            if (coverage) (s.coverage ??= {})[r.mode!] = { at: receivedAt, ...coverage };
          }
        } catch (error) { fail(r, failureCode(error)); }
      });
      if (entries.length) {
        entries.sort((a, b) => a.method.localeCompare(b.method) || (a.mode ?? a.stop ?? '').localeCompare(b.mode ?? b.stop ?? ''));
        const bytes = encode(JSON.stringify({ v: 1, source: 'NJ Transit BUSDV2', responses: entries }));
        if (containsSecret(bytes, [...secrets])) fail(undefined, 'invalid-response');
        else responses.push({ feed: 'busdv-poll', receivedAt: Math.max(...entries.map(e => e.receivedAt)), bytes });
      }
      s.reason = failures[0]?.code ?? 'ready';
      return finish();
    } finally { this.collecting = false; }
  }
}
