// Live train boards from Dale's Worker (`/v1/rail`, docs/RAIL_LIVE.md). Only what NJ Transit sent; nothing guessed.
import type { StationChoice } from './journeyGuide';
import type { RailDirection } from './railTimetable';

export type RailBoardCode = 'AS' | 'EX' | 'TS' | 'SE' | 'NY';
export const RAIL_HOME_CODES: Record<StationChoice, RailBoardCode> = { anderson: 'AS', essex: 'EX' };
/** Boards a rider needs: toward New York, the home station; coming home, New York Penn and the Pascack Valley platform at Secaucus. */
export function railBoardsFor(station: StationChoice, direction: RailDirection): RailBoardCode[] {
  return direction === 'outbound' ? [RAIL_HOME_CODES[station]] : ['NY', 'TS'];
}
/** Older than this, a board is shown as out of date rather than current. */
export const RAIL_STALE_MS = 3 * 60_000;
/** Departures this long past their scheduled time (plus NJ Transit's delay) drop off the board. */
const GONE_MS = 60_000;

export interface LiveRailDeparture {
  trainId: string; line: string | null; lineCode: string | null; destination: string | null; scheduledAt: number;
  track: string | null; status: string | null; secondsLate: number | null; updatedAt: number | null;
}
export type LiveRailBoard =
  | { state: 'ok'; station: RailBoardCode; receivedAt: number; departures: LiveRailDeparture[]; stale: boolean }
  | { state: 'unavailable'; station: RailBoardCode };

const text = (v: unknown, max: number) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= max) ? v as string | null : undefined;
const time = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 946_684_800_000 && v < 4_102_444_800_000;

/** Validate one Worker answer. Anything malformed is unavailable, never partly shown. */
export function parseLiveRailBoard(raw: unknown, station: RailBoardCode, now: number): LiveRailBoard {
  const off = { state: 'unavailable' as const, station };
  if (!raw || typeof raw !== 'object') return off;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || r.station !== station || r.state !== 'ok' || !time(r.receivedAt) || !Array.isArray(r.departures) || r.departures.length > 40) return off;
  const receivedAt = r.receivedAt as number;
  // A clock far ahead of this phone is not trusted as fresh.
  if (receivedAt > now + 5 * 60_000) return off;
  const departures: LiveRailDeparture[] = [];
  for (const d of r.departures as unknown[]) {
    if (!d || typeof d !== 'object') return off;
    const x = d as Record<string, unknown>;
    const fields = {
      line: text(x.line, 40), lineCode: text(x.lineCode, 4), destination: text(x.destination, 64), track: text(x.track, 8), status: text(x.status, 40),
    };
    if (typeof x.trainId !== 'string' || !/^[A-Za-z0-9]{1,12}$/.test(x.trainId) || !time(x.scheduledAt)
      || Object.values(fields).some((v) => v === undefined)
      || !(x.secondsLate === null || (Number.isSafeInteger(x.secondsLate) && Math.abs(x.secondsLate as number) < 1_000_000))
      || !(x.updatedAt === null || time(x.updatedAt))) return off;
    departures.push({ trainId: x.trainId, ...fields as { [K in keyof typeof fields]: string | null }, scheduledAt: x.scheduledAt as number,
      secondsLate: x.secondsLate as number | null, updatedAt: x.updatedAt as number | null });
  }
  return { state: 'ok', station, receivedAt, stale: now - receivedAt > RAIL_STALE_MS,
    departures: departures.filter((d) => d.scheduledAt + Math.max(0, d.secondsLate ?? 0) * 1000 + GONE_MS > now).sort((a, b) => a.scheduledAt - b.scheduledAt) };
}

/** Whole minutes late, only when NJ Transit reports at least one; never an inferred delay. */
export function minutesLate(d: LiveRailDeparture): number | null {
  return d.secondsLate !== null && d.secondsLate >= 60 ? Math.floor(d.secondsLate / 60) : null;
}
