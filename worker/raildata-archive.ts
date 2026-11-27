import { HISTORY_INTERVAL_MS } from './history-journal';
import { reserveRequests, type RequestBudget } from './request-budget';
import { containsSecret } from './busdv-archive';
import { RAIL_STATIONS, RailError, railArchiveFailure, type RailArchiveMethod } from './rail';
import type { RawFeed, RawResponse } from './raw-archive';
import { ARCHIVE_CONNECTIONS, ARCHIVE_START_MS, ARCHIVE_TURN_MS, inPool } from './pool';

/** D84 ("save all the data"): every RailData answer NJ Transit serves statewide, saved raw and private.
 *  Cadence follows the approved statewide plan: train positions every poll, every station's departure
 *  board every 15 minutes, station messages hourly, the station list and full station schedule daily. */
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, BOARD_CYCLE_MS = 15 * MINUTE;
/** Leaves a quarter of NJ Transit's 40,000 a day for the Train screen, which shares the same key. */
export const RAILDATA_REQUEST_LIMIT = 30_000;
const MAX_BOARDS_PER_POLL = 16, BOARD_MAX_BYTES = 2 * 1024 * 1024, POLL_MAX_BYTES = 8 * 1024 * 1024, DAILY_MAX_BYTES = 32 * 1024 * 1024;

export interface RailDataState {
  budget: RequestBudget; cursor: number;
  /** Station codes from the last good getStationList; until then, the Train screen's stations. */
  stations?: string[];
  tried: Partial<Record<Step, number>>; ok: Partial<Record<Step, number>>; reason?: string;
}
type Step = 'vehicles' | 'boards' | 'messages' | 'list' | 'schedule';
export const newRailDataState = (): RailDataState => ({ budget: { hours: {} }, cursor: 0, tried: {}, ok: {} });
export interface RailDataPlan { vehicles: boolean; boards: string[]; messages: boolean; list: boolean; schedule: boolean }
export interface RailDataFailure { feed: RawFeed; code: string; at: number }
export interface RailDataSource {
  archiveRequest(method: RailArchiveMethod, fields: Record<string, string>, maxBytes: number, timeoutMs?: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; token: string }>;
}
interface BundleEntry { method: RailArchiveMethod; station?: string; receivedAt: number; status: 'ok' | string; text?: string; base64?: string }

const count = (plan: RailDataPlan) => (plan.vehicles ? 1 : 0) + plan.boards.length + (plan.messages ? 1 : 0) + (plan.list ? 1 : 0) + (plan.schedule ? 1 : 0);
const daily = (s: RailDataState, step: Step, now: number) => now - (s.ok[step] ?? -Infinity) >= DAY && now - (s.tried[step] ?? -Infinity) >= HOUR;

/** Station codes from getStationList's answer. Anything unexpected keeps the previous list. */
export function stationCodes(bytes: Uint8Array): string[] | undefined {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
  if (!Array.isArray(value)) return;
  const codes = [...new Set(value.map(row => row && typeof row === 'object' ? (row as Record<string, unknown>).STATION_2CHAR : undefined)
    .filter((code): code is string => typeof code === 'string' && /^[A-Z0-9]{2}$/.test(code.trim())).map(code => code.trim()))].sort();
  return codes.length >= 10 ? codes : undefined;
}

/** Exact text when it is valid UTF-8 (the JSON NJ Transit sends), otherwise base64, so every byte can be rebuilt. */
function preserve(bytes: Uint8Array): Pick<BundleEntry, 'text' | 'base64'> {
  try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; }
  catch {
    // In chunks: one string join per 32 KB instead of one per byte (Neon DEEP Nov 26).
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
    return { base64: btoa(parts.join('')) };
  }
}

export class RailDataArchive {
  constructor(private state: RailDataState, private source: RailDataSource, private clock = Date.now) {}

  /** Chooses and reserves this poll's requests. The caller persists the state before any I/O,
   *  so an eviction can never repeat a reservation's requests. */
  prepare(now: number): RailDataPlan | 'request-ceiling' | undefined {
    const s = this.state;
    const stations = s.stations?.length ? s.stations : Object.keys(RAIL_STATIONS);
    const sinceBoards = now - (s.tried.boards ?? now - HISTORY_INTERVAL_MS);
    const boardCount = Math.min(MAX_BOARDS_PER_POLL, stations.length, Math.max(1, Math.ceil(stations.length * Math.max(sinceBoards, HISTORY_INTERVAL_MS) / BOARD_CYCLE_MS)));
    const cursor = s.cursor % stations.length;
    const plan: RailDataPlan = {
      vehicles: now - (s.tried.vehicles ?? -Infinity) >= HISTORY_INTERVAL_MS,
      boards: Array.from({ length: boardCount }, (_, n) => stations[(cursor + n) % stations.length]!),
      messages: now - (s.tried.messages ?? -Infinity) >= HOUR,
      list: daily(s, 'list', now), schedule: daily(s, 'schedule', now),
    };
    if (!plan.vehicles) plan.boards = [];
    if (!count(plan)) return;
    // Near the daily ceiling, boards give way first, so train positions and the daily files still fit
    // (Neon DEEP Nov 26: all or nothing refused the positions too).
    if (!reserveRequests(s.budget, count(plan), now, RAILDATA_REQUEST_LIMIT)) {
      if (!plan.boards.length) return s.reason = 'request-ceiling';
      plan.boards = [];
      if (!count(plan) || !reserveRequests(s.budget, count(plan), now, RAILDATA_REQUEST_LIMIT)) return s.reason = 'request-ceiling';
    }
    for (const step of ['vehicles', 'messages', 'list', 'schedule'] as const) if (plan[step]) s.tried[step] = now;
    if (plan.boards.length) { s.tried.boards = now; s.cursor = (cursor + plan.boards.length) % stations.length; }
    return plan;
  }

  async collect(plan: RailDataPlan): Promise<{ responses: RawResponse[]; failures: RailDataFailure[]; secrets: string[] }> {
    const responses: RawResponse[] = [], failures: RailDataFailure[] = [], secrets = new Set<string>(), entries: BundleEntry[] = [];
    const started = this.clock();
    const call = async (method: RailArchiveMethod, fields: Record<string, string>, max: number, station?: string) => {
      try {
        // The live bus poll waits for this turn, so a slow NJ Transit answer cannot hold it (Neon, #303):
        // nothing starts after ARCHIVE_START_MS, and nothing runs past ARCHIVE_TURN_MS.
        const elapsed = this.clock() - started;
        if (elapsed >= ARCHIVE_START_MS) throw new RailError('timed-out');
        const { bytes, token } = await this.source.archiveRequest(method, fields, max, ARCHIVE_TURN_MS - elapsed);
        secrets.add(token);
        // Checked on the exact answer, before preserve() may turn it into base64 the bundle's own scan
        // could not read (Neon, #303 and Nov26 g). An answer holding the token is never saved.
        if (containsSecret(bytes, [token])) throw new RailError('unexpected-response');
        return bytes;
      } catch (error) {
        const code = railArchiveFailure(error), at = this.clock();
        failures.push({ feed: `raildata-${method}`, code, at });
        entries.push({ method, ...(station ? { station } : {}), receivedAt: at, status: code });
      }
    };
    const bundled = async (method: RailArchiveMethod, fields: Record<string, string>, step: Step, station?: string) => {
      const bytes = await call(method, fields, method === 'getTrainSchedule' ? BOARD_MAX_BYTES : POLL_MAX_BYTES, station);
      if (!bytes) return;
      entries.push({ method, ...(station ? { station } : {}), receivedAt: this.clock(), status: 'ok', ...preserve(bytes) });
      this.state.ok[step] = this.clock();
    };
    const whole = async (method: 'getStationList' | 'getStationSchedule', fields: Record<string, string>, step: Step) => {
      const bytes = await call(method, fields, DAILY_MAX_BYTES);
      if (!bytes) return;
      responses.push({ feed: `raildata-${method}`, bytes, receivedAt: this.clock() });
      this.state.ok[step] = this.clock();
      if (method === 'getStationList') { const codes = stationCodes(bytes); if (codes) this.state.stations = codes; }
    };
    // Two at a time, so queued calls never spend their timeout waiting for one of the Worker's 6 connections.
    const tasks: (undefined | (() => Promise<void>))[] = [
      plan.vehicles ? () => bundled('getVehicleData', {}, 'vehicles') : undefined,
      // Blank station and line ask for every station's messages (not checked against a live answer yet).
      plan.messages ? () => bundled('getStationMSG', { station: '', line: '' }, 'messages') : undefined,
      plan.list ? () => whole('getStationList', {}, 'list') : undefined,
      plan.schedule ? () => whole('getStationSchedule', { station: '', NJTOnly: 'false' }, 'schedule') : undefined,
      // Boards last: up to 16 catch-up boards must not push the hourly and daily calls past the start cutoff.
      ...plan.boards.map(station => () => bundled('getTrainSchedule', { station }, 'boards', station)),
    ];
    await inPool(tasks.filter(task => task !== undefined), ARCHIVE_CONNECTIONS, task => task());
    // One saved object per poll instead of one per answer keeps R2 operations near the bus feeds' rate.
    // Failed requests stay in the bundle as fixed codes, so a gap is visible inside the evidence too.
    if (entries.some(e => e.status === 'ok')) {
      const receivedAt = Math.max(...entries.map(e => e.receivedAt));
      entries.sort((a, b) => a.method.localeCompare(b.method) || (a.station ?? '').localeCompare(b.station ?? ''));
      responses.push({ feed: 'raildata-poll', receivedAt, bytes: new TextEncoder().encode(JSON.stringify({ v: 1, source: 'NJ Transit RailData TrainData', responses: entries })) as Uint8Array<ArrayBuffer> });
    }
    this.state.reason = failures[0]?.code ?? 'ready';
    return { responses, failures, secrets: [...secrets] };
  }
}
