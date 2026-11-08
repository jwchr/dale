// Trip progress while riding (owner request 2026-11-04): where the bus is along the line and whether
// it is ahead of or behind the timetable, from the freshest evidence available. Evidence, best first
// when equally fresh: the matched bus's GPS, the rider's own phone GPS (they are on the bus), and the
// rider's taps ("we're at this stop"). Without any, the position is the timetable's, labeled as such,
// and no ahead/behind is claimed. Pure: positions are passed in, nothing is stored here.
import { DEFAULT_TIMING } from './lock';
import { progressAlong } from './rideGuide';
import type { Stop } from './types';

export interface Fix { lat: number; lon: number; at: number; accuracyM: number }
export type EvidenceSource = 'tap' | 'phone_gps' | 'bus_gps';
export interface Milestone { index: number; at: number; source: EvidenceSource }

export interface ProgressInput {
  /** The trip's stops in order, with scheduled times (epoch ms). */
  stops: readonly (Stop | undefined)[];
  times: readonly number[];
  boardIndex: number;
  alightIndex: number;
  now: number;
  milestones: readonly Milestone[];
  phone?: Fix;
  bus?: Fix;
}

export type ProgressBasis = EvidenceSource | 'timetable';

export interface TripProgress {
  /** Fractional stop index (3.5 = halfway between stops 3 and 4). */
  position: number;
  /** True when the position is carried forward from older evidence at the same pace, not observed now. */
  projected: boolean;
  basis: ProgressBasis;
  observedAt?: number;
  /** Minutes behind (+) or ahead (−) of the timetable, rounded; 0 = within a minute; undefined without evidence. */
  delayMin?: number;
  /** Highest stop index confirmed reached (by a tap or a GPS fix at the stop). */
  reachedIndex: number;
  /** Scheduled arrival at the rider's stop, and the same shifted by the delay ("if it keeps this pace"). */
  alight: { scheduled: number; projected?: number };
}

/** A GPS fix this old or less precise is not used. */
export const FIX_MAX_AGE_MS = DEFAULT_TIMING.staleAfterMs;
export const FIX_MAX_ACCURACY_M = 150;
/** A fix this close to a stop counts as reaching it (and must itself be at least this precise). */
export const AT_STOP_M = 80;
/** A tap says where the bus was then; after this long it no longer says anything about now. */
export const TAP_MAX_AGE_MS = 20 * 60_000;
const OFF_ROUTE_M = 400;

type Located = Stop & { lat: number; lon: number };
const isLocated = (s: Stop | undefined): s is Located => typeof s?.lat === 'number' && typeof s?.lon === 'number';
export const hasLocations = (stops: readonly (Stop | undefined)[]) => stops.length > 1 && stops.every(isLocated);

/** Scheduled time at a fractional position along the trip. */
export function scheduledAt(times: readonly number[], p: number): number {
  const i = Math.max(0, Math.min(times.length - 2, Math.floor(p)));
  const f = Math.max(0, Math.min(1, p - i));
  return times[i]! + f * (times[i + 1]! - times[i]!);
}

/** Where the timetable puts the bus at `t`, as a fractional stop index, clamped to the trip. */
export function timetablePosition(times: readonly number[], t: number): number {
  if (t <= times[0]!) return 0;
  for (let i = 0; i < times.length - 1; i++) {
    const a = times[i]!, b = times[i + 1]!;
    if (t < b) return b > a ? i + (t - a) / (b - a) : i + 1;
  }
  return times.length - 1;
}

/** The trip position a GPS fix shows, or undefined when it is old, imprecise, off the route or ambiguous. */
export function fixPosition(stops: readonly (Stop | undefined)[], from: number, fix: Fix, now: number): number | undefined {
  if (!hasLocations(stops) || now - fix.at > FIX_MAX_AGE_MS || fix.at > now + 60_000 || fix.accuracyM > FIX_MAX_ACCURACY_M) return undefined;
  const line = stops as Located[];
  const r = progressAlong(line, Math.max(0, from - 1), line.length - 1, fix);
  return r && r.offM <= OFF_ROUTE_M ? r.progress : undefined;
}

/**
 * The stop a fix is at, for an automatic milestone: only the stop nearest the fix's own position along
 * the route (`position`, from fixPosition, which already refuses ambiguous fixes), only beyond `after`,
 * within AT_STOP_M, and only from a fix at least that precise. A street that doubles back can never
 * mark a later stop on the parallel side.
 */
export function stopReached(stops: readonly (Stop | undefined)[], after: number, fix: Fix, position: number | undefined): number | undefined {
  if (position === undefined || fix.accuracyM > AT_STOP_M) return undefined;
  const i = Math.round(position);
  const s = stops[i];
  return i > after && isLocated(s) && metres(s, fix) <= AT_STOP_M ? i : undefined;
}

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const kx = Math.cos((a.lat * Math.PI) / 180) * 111_320;
  return Math.hypot((a.lon - b.lon) * kx, (a.lat - b.lat) * 110_540);
}

export function tripProgress(input: ProgressInput): TripProgress {
  const { stops, times, boardIndex, alightIndex, now, milestones } = input;
  const reachedIndex = Math.max(boardIndex, ...milestones.map((m) => m.index));
  const evidence: { position: number; at: number; source: EvidenceSource }[] = [];
  const last = [...milestones].sort((a, b) => a.at - b.at || a.index - b.index).at(-1);
  if (last && now - last.at <= (last.source === 'tap' ? TAP_MAX_AGE_MS : FIX_MAX_AGE_MS)) evidence.push({ position: last.index, at: last.at, source: last.source });
  for (const [fix, source] of [[input.bus, 'bus_gps'], [input.phone, 'phone_gps']] as const) {
    if (!fix) continue;
    const p = fixPosition(stops, boardIndex, fix, now);
    // Never behind a stop already confirmed: GPS jitter does not move the bus backwards.
    if (p !== undefined) evidence.push({ position: Math.max(p, reachedIndex), at: fix.at, source });
  }
  const rank: Record<EvidenceSource, number> = { bus_gps: 0, phone_gps: 1, tap: 2 };
  const best = evidence.sort((a, b) => b.at - a.at || rank[a.source] - rank[b.source])[0];
  const scheduledAlight = times[alightIndex]!;
  if (!best) {
    // The timetable's position (labeled as such), never behind a stop already confirmed. It confirms
    // nothing: the strip only marks stops reached from taps or GPS.
    return { position: Math.max(boardIndex, reachedIndex, timetablePosition(times, now)), projected: false, basis: 'timetable', reachedIndex, alight: { scheduled: scheduledAlight } };
  }
  const delayMs = best.at - scheduledAt(times, best.position);
  // Between updates, carry the bus forward at the observed pace, but only up to just before the next
  // stop: reaching a stop takes evidence, never an estimate.
  const nextStop = Math.min(times.length - 1, Math.floor(best.position + 1e-6) + 1);
  const carried = Math.min(timetablePosition(times, now - delayMs), nextStop - 0.02);
  const position = best.source === 'tap' ? Math.min(times.length - 1, Math.max(best.position, carried)) : best.position;
  return {
    position, projected: position > best.position + 0.01, basis: best.source, observedAt: best.at,
    delayMin: Math.abs(delayMs) < 60_000 ? 0 : Math.round(delayMs / 60_000), reachedIndex,
    alight: { scheduled: scheduledAlight, projected: scheduledAlight + delayMs },
  };
}
