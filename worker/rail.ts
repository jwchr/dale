// Live train departures from NJ Transit RailData (#80). Fixed official host, five fixed stations, one shared token.
// Field names and types follow the production schema (raildata.njtransit.com/swagger/RailData/swagger.json):
// the scalar fields Dale reads are nullable strings; ITEMS, STATIONMSGS, CAPACITY and STOPS are nullable arrays. The date layout and the New York time zone are not stated there; they follow
// the open-source jtarrio/raildata client (Apache-2.0) and are checked by parsing, never assumed: a row whose time
// does not parse is dropped and counted. See docs/RAIL_LIVE.md.
import { tzOffsetMinutes } from '../src/domain/time';
import type { Credentials } from './njt-client';

export const RAIL_HOST = 'https://raildata.njtransit.com';
export const RAIL_SOURCE = 'NJ Transit RailData';
/** The household stations, Secaucus (two levels, never merged) and New York Penn, with the line filter each uses. */
export const RAIL_STATIONS: Readonly<Record<string, string>> = { AS: 'PV', EX: 'PV', TS: 'PV', SE: '', NY: '' };
/** One agency request per station per minute at most: five stations stay under 7,200 a day, below the 40,000 limit. */
export const RAIL_BOARD_MS = 60_000;
/** NJ Transit allows 10 token requests a day and recommends one. Dale uses at most 3, an hour apart, so the manual
 * rail check keeps room for its own (docs/RAIL_API_CHECK.md). */
export const RAIL_MINTS_PER_DAY = 3;
const MINT_GAP_MS = 3600_000, DAY_MS = 24 * 3600_000, TOKEN_REFRESH_MS = 23 * 3600_000;
const MAX_ROWS = 40, MAX_BYTES = 524_288, TIMEOUT_MS = 12_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TIME_ZONE = 'America/New_York';

export interface RailDeparture {
  trainId: string; line: string | null; lineCode: string | null; destination: string | null;
  /** NJ Transit's scheduled departure from this station (epoch ms). */
  scheduledAt: number;
  /** Only when NJ Transit names one; never guessed. */
  track: string | null;
  /** NJ Transit's own status words (for example "BOARDING"), unchanged apart from spacing. */
  status: string | null;
  /** NJ Transit's delay in seconds; negative is early. Null when NJ Transit gives none. */
  secondsLate: number | null;
  /** When NJ Transit last changed this row (epoch ms), or null. */
  updatedAt: number | null;
}
/** Secaucus lower-level tracks as signed for riders: NJ Transit RailData V2.1 Appendix II (as quoted in review) and the
 * jtarrio/raildata client's SpecialTracks table agree. Applied to TS only, never to SE. */
const TS_SIGNED_TRACKS: Readonly<Record<string, string>> = { '1': 'G', '2': 'F', '3': 'H', '4': 'E' };
export type RailFailure = 'service-message' | 'configuration-missing' | 'token-limit' | 'access-denied' | 'rate-limited' | 'http-error'
  | 'timed-out' | 'network-error' | 'response-too-large' | 'unexpected-response' | 'unexpected-schema' | 'api-error';
export interface RailBoard {
  v: 1; source: typeof RAIL_SOURCE; station: string;
  state: 'ok' | 'unavailable'; reason?: RailFailure;
  /** When Dale received this answer from NJ Transit; null when there is none. Receipt is not NJ Transit's own time. */
  receivedAt: number | null;
  departures: RailDeparture[];
  /** Rows dropped because a required field was missing or did not parse. */
  skippedRows: number;
}

class RailError extends Error { constructor(readonly code: RailFailure) { super(code); } }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** "18-Nov-2026 09:15:00 PM" in New York time, to epoch ms; undefined when it is not exactly that shape and a real date. */
export function parseRailTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return;
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([AP]M)$/.exec(value.trim());
  if (!m) return;
  const day = Number(m[1]), month = MONTHS.indexOf(m[2]![0]!.toUpperCase() + m[2]!.slice(1).toLowerCase()) + 1, year = Number(m[3]);
  const hour12 = Number(m[4]), minute = Number(m[5]), second = Number(m[6]);
  if (month < 1 || hour12 < 1 || hour12 > 12 || minute > 59 || second > 59 || year < 2000 || year > 2100) return;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) return;
  const hour = (hour12 % 12) + (m[7] === 'PM' ? 12 : 0);
  // Only a wall time that names exactly one instant: a time skipped in spring or repeated in fall is not guessed.
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const fits = [wall + 4 * 3600_000, wall + 5 * 3600_000].filter((t) => t + tzOffsetMinutes(t, TIME_ZONE) * 60_000 === wall);
  return fits.length === 1 ? fits[0] : undefined;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Plain, bounded display text: entities decoded, tags and control characters removed, spacing collapsed. */
export function railText(value: unknown, max = 64): string | null {
  // Bounded before any pattern runs, so a hostile field cannot make cleanup slow.
  if (typeof value !== 'string' || value.length > max * 8) return null;
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d{1,7});|&#x([0-9a-f]{1,6});|&([a-z]{2,6});/gi, (all, dec, hex, name) => {
      const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : undefined;
      if (code !== undefined) return code > 31 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) && code !== 127 ? String.fromCodePoint(code) : ' ';
      return ENTITIES[String(name).toLowerCase()] ?? all;
    })
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return text && text.length <= max ? text : null;
}

const signedTrack = (station: string, track: string | null) => track && station === 'TS' ? TS_SIGNED_TRACKS[track] ?? track : track;

/** One getTrainSchedule19Rec answer, reduced to what the Train screen shows. GPS, capacity, colors and messages are dropped. */
export function normalizeRailBoard(value: unknown, station: string, receivedAt: number): RailBoard {
  // The response's station name is a short form ("New York" for New York Penn Station), so only the code must match.
  if (!object(value) || value.STATION_2CHAR !== station || !('ITEMS' in value)) throw new RailError('unexpected-schema');
  const items = value.ITEMS === null ? [] : value.ITEMS;
  if (!Array.isArray(items)) throw new RailError('unexpected-schema');
  // A fullscreen station message replaces the board and leaves ITEMS empty: that is not "no trains". Its text is never shown.
  if (!items.length && Array.isArray(value.STATIONMSGS)
    && value.STATIONMSGS.some((m) => object(m) && typeof m.MSG_TYPE === 'string' && m.MSG_TYPE.trim().toLowerCase() === 'fullscreen')) throw new RailError('service-message');
  const departures: RailDeparture[] = [];
  let skippedRows = Math.max(0, items.length - MAX_ROWS);
  for (const row of items.slice(0, MAX_ROWS)) {
    const trainId = object(row) && typeof row.TRAIN_ID === 'string' ? row.TRAIN_ID.trim() : '';
    const scheduledAt = object(row) ? parseRailTime(row.SCHED_DEP_DATE) : undefined;
    if (!object(row) || !/^[A-Za-z0-9]{1,12}$/.test(trainId) || scheduledAt === undefined) { skippedRows++; continue; }
    const late = typeof row.SEC_LATE === 'string' && /^-?\d{1,6}$/.test(row.SEC_LATE.trim()) ? Number(row.SEC_LATE.trim()) : null;
    departures.push({
      trainId, line: railText(row.LINE, 40), lineCode: railText(row.LINECODE, 4), destination: railText(row.DESTINATION),
      scheduledAt, track: signedTrack(station, railText(row.TRACK, 8)), status: railText(row.STATUS, 40), secondsLate: late,
      updatedAt: parseRailTime(row.LAST_MODIFIED) ?? null,
    });
  }
  departures.sort((a, b) => a.scheduledAt - b.scheduledAt || a.trainId.localeCompare(b.trainId));
  return { v: 1, source: RAIL_SOURCE, station, state: 'ok', receivedAt, departures, skippedRows };
}

/** POST a multipart form to one fixed RailData method. Bodies, headers and messages never leave this function. */
async function railRequest(method: string, fields: Record<string, string>, fetchImpl: typeof fetch): Promise<unknown> {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    const response = await fetchImpl(`${RAIL_HOST}/api/TrainData/${method}`, {
      method: 'POST', body, headers: { accept: 'application/json' }, redirect: 'manual', cache: 'no-store', signal: ctl.signal,
    });
    const statusFailure: RailFailure | undefined = response.status === 401 || response.status === 403 ? 'access-denied'
      : response.status === 429 ? 'rate-limited' : response.ok ? undefined : 'http-error';
    if (!response.body) throw new RailError(statusFailure ?? 'unexpected-response');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { void reader.cancel().catch(() => {}); throw new RailError('response-too-large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RailError(statusFailure ?? 'unexpected-response'); }
    // NJ Transit's guide shows "Invalid token." as a body without naming an HTTP status, so the body decides.
    if (object(value) && typeof value.errorMessage === 'string') {
      throw new RailError(/invalid token/i.test(value.errorMessage) ? 'access-denied' : /daily usage limit/i.test(value.errorMessage) ? 'rate-limited' : statusFailure ?? 'api-error');
    }
    if (statusFailure) throw new RailError(statusFailure);
    return value;
  } catch (error) {
    if (error instanceof RailError) throw error;
    throw new RailError(ctl.signal.aborted ? 'timed-out' : 'network-error');
  } finally { clearTimeout(timer); ctl.abort(); }
}

export interface RailStorage { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }
interface RailSaved { token?: { value: string; at: number }; mints: number[] }
const RAIL_KEY = 'rail-v1';

/** Serves one cached board per station. Token requests are counted in storage before they are sent, so a restart cannot overspend. */
export class RailBoards {
  private saved?: RailSaved;
  private boards = new Map<string, { at: number; board: RailBoard }>();
  private loading = new Map<string, Promise<RailBoard>>();
  private minting?: Promise<string>;
  constructor(private storage: RailStorage, private env: Credentials, private fetchImpl: typeof fetch = fetch, private clock = Date.now) {}

  async board(station: string): Promise<RailBoard> {
    if (!Object.hasOwn(RAIL_STATIONS, station)) throw new Error('unknown station');
    const cached = this.boards.get(station);
    if (cached && this.clock() - cached.at < RAIL_BOARD_MS) return cached.board;
    let task = this.loading.get(station);
    if (!task) {
      task = this.load(station).finally(() => this.loading.delete(station));
      this.loading.set(station, task);
    }
    return task;
  }

  /** Token requests in the last 24 hours, for the health page. Never the token. */
  async health(): Promise<{ tokenRequests24h: number; hasToken: boolean }> {
    const saved = await this.state(), now = this.clock();
    return { tokenRequests24h: saved.mints.filter((at) => now - at < DAY_MS).length, hasToken: !!saved.token };
  }

  private async state(): Promise<RailSaved> {
    if (!this.saved) {
      const stored = await this.storage.get<RailSaved>(RAIL_KEY);
      this.saved = {
        mints: Array.isArray(stored?.mints) ? stored.mints.filter(Number.isFinite) : [],
        ...(stored?.token && typeof stored.token.value === 'string' && Number.isFinite(stored.token.at) ? { token: stored.token } : {}),
      };
    }
    return this.saved;
  }

  private async load(station: string): Promise<RailBoard> {
    let board: RailBoard;
    try { board = await this.fetchBoard(station); }
    catch (error) {
      const reason = error instanceof RailError ? error.code : 'unexpected-response';
      board = { v: 1, source: RAIL_SOURCE, station, state: 'unavailable', reason, receivedAt: null, departures: [], skippedRows: 0 };
    }
    // Failures are cached for the same minute, so a broken feed is never hammered.
    this.boards.set(station, { at: this.clock(), board });
    return board;
  }

  /** Exactly one schedule request per call. A refused token is dropped; the next minute may mint a new one. */
  private async fetchBoard(station: string): Promise<RailBoard> {
    const saved = await this.state();
    const token = saved.token && this.clock() - saved.token.at < TOKEN_REFRESH_MS ? saved.token.value : await this.token();
    try {
      return normalizeRailBoard(await railRequest('getTrainSchedule19Rec', { token, station, line: RAIL_STATIONS[station]! }, this.fetchImpl), station, this.clock());
    } catch (error) {
      // Only while it is still the stored token, so a newer one from another station is kept.
      if (error instanceof RailError && error.code === 'access-denied' && saved.token?.value === token) { saved.token = undefined; await this.storage.put(RAIL_KEY, saved); }
      throw error;
    }
  }

  /** A new token, shared by concurrent callers. Never more than RAIL_MINTS_PER_DAY a day or one an hour. */
  private token(): Promise<string> {
    if (!this.minting) this.minting = this.mint().finally(() => { this.minting = undefined; });
    return this.minting;
  }

  private async mint(): Promise<string> {
    const saved = await this.state(), now = this.clock();
    if (saved.token && now - saved.token.at < TOKEN_REFRESH_MS) return saved.token.value;
    if (!this.env.NJT_API_USERNAME?.trim() || !this.env.NJT_API_PASSWORD?.trim()) throw new RailError('configuration-missing');
    saved.mints = saved.mints.filter((at) => now - at < DAY_MS);
    const last = Math.max(0, ...saved.mints);
    if (saved.mints.length >= RAIL_MINTS_PER_DAY || now - last < MINT_GAP_MS) throw new RailError('token-limit');
    saved.mints.push(now);
    await this.storage.put(RAIL_KEY, saved);
    const value = await railRequest('getToken', { username: this.env.NJT_API_USERNAME, password: this.env.NJT_API_PASSWORD }, this.fetchImpl);
    const flag = object(value) ? value.Authenticated : undefined;
    const ok = flag === true || (typeof flag === 'string' && flag.trim().toLowerCase() === 'true');
    if (!ok) throw new RailError(flag === false || (typeof flag === 'string' && flag.trim().toLowerCase() === 'false') ? 'access-denied' : 'unexpected-response');
    const token = object(value) && typeof value.UserToken === 'string' ? value.UserToken.trim() : '';
    if (!token) throw new RailError('unexpected-response');
    saved.token = { value: token, at: now };
    await this.storage.put(RAIL_KEY, saved);
    return token;
  }
}
