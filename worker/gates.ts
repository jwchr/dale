import { parseLaneGate } from '../src/domain/gate';
import { isServiceActive, tripTimeAt } from '../src/domain/schedule';
import { addDays, localHour, localYmd, tzOffsetMinutes } from '../src/domain/time';
import { tripInstanceId, type Dataset } from '../src/domain/types';
import { NjtError } from './njt-client';

export const PABT_TIMING_POINTS: readonly string[] = ['NWYKPABT'];
export const GATE_MAX_AGE_MS = 120_000;
const TZ = 'America/New_York';
export interface DvRow { public_route: unknown; sched_dep_time: unknown; timing_point_id: unknown; lanegate: unknown }
export interface Posting { tripInstanceId: string; boardingIndex: number; gate: string; door?: string; source: 'njt-departurevision'; receivedAt: number }
export interface GateCandidate { tripInstanceId: string; boardingIndex: number; route: string; at: number }
export type DropReason = 'invalid-date' | 'invalid-gate' | 'unmatched' | 'ambiguous' | 'conflict' | 'wrong-terminal';
export interface GateDiagnostics { day: string; rowsSeen: number; matched: number; drops: Record<DropReason, number>; timingPoints: string[]; scheduleShapes: string[]; gateShapes: string[] }
export function newGateDiagnostics(now: number): GateDiagnostics {
  return { day: localYmd(now, TZ), rowsSeen: 0, matched: 0, drops: { 'invalid-date': 0, 'invalid-gate': 0, unmatched: 0, ambiguous: 0, conflict: 0, 'wrong-terminal': 0 }, timingPoints: [], scheduleShapes: [], gateShapes: [] };
}
/** Only copy the four relevant fields. Never retain the body or unrelated row properties. */
export function parseDvResponse(bytes: Uint8Array): DvRow[] {
  if (bytes.byteLength > 256 * 1024) throw new NjtError('response-too-large');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new NjtError('invalid-response'); }
  const arrays = Array.isArray(value) ? [value] : value && typeof value === 'object'
    ? Object.entries(value).filter(([key]) => /^dvtrip$/i.test(key)).map(([, rows]) => rows) : [];
  if (arrays.length !== 1 || !Array.isArray(arrays[0]) || arrays[0].length > 500) throw new NjtError('invalid-response');
  return arrays[0].map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new NjtError('invalid-response');
    const r = row as Record<string, unknown>;
    if (['public_route', 'sched_dep_time', 'timing_point_id', 'lanegate'].some(k => r[k] !== undefined && r[k] !== null && typeof r[k] !== 'string')) throw new NjtError('invalid-response');
    return { public_route: r.public_route, sched_dep_time: r.sched_dep_time, timing_point_id: r.timing_point_id, lanegate: r.lanegate };
  });
}
/** Strict Eastern wall time, rejecting both DST gaps and repeated hours. */
export function parseSchedDepTime(text: unknown): number | null {
  if (typeof text !== 'string' || text.length > 25) return null;
  let y: number, m: number, d: number, h: number, min: number, sec: number;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):([0-5]\d)(?::([0-5]\d))? (AM|PM)$/.exec(text);
  const military = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
  const a = us ?? military ?? iso;
  if (!a) return null;
  if (iso) { y = +a[1]!; m = +a[2]!; d = +a[3]!; } else { m = +a[1]!; d = +a[2]!; y = +a[3]!; }
  h = +a[4]!; min = +a[5]!; sec = +(a[6] ?? 0);
  if (us) { if (h < 1 || h > 12) return null; h = h % 12 + (a[7] === 'PM' ? 12 : 0); }
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31 || h > 23) return null;
  const wall = Date.UTC(y, m - 1, d, h, min, sec), date = new Date(wall);
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const offsets = new Set([tzOffsetMinutes(wall - 86400_000, TZ), tzOffsetMinutes(wall + 86400_000, TZ)]);
  const valid = [...offsets].map(offset => wall - offset * 60_000).filter(at => at + tzOffsetMinutes(at, TZ) * 60_000 === wall);
  return valid.length === 1 ? valid[0]! : null;
}
/** All exact PABT calls, including a second terminal boarding call on the same pattern. */
export function gateCandidates(ds: Dataset, now: number): GateCandidate[] {
  const today = localYmd(now, TZ), dates = [addDays(today, -1), today];
  if (localHour(now, TZ) === 23) dates.push(addDays(today, 1));
  const pabt = new Set(ds.stops.filter(s => s.terminal === 'PABT').map(s => s.id));
  const patterns = new Map(ds.patterns.map(p => [p.id, p])), routes = new Map(ds.routes.map(r => [r.id, r.shortName]));
  const out: GateCandidate[] = [];
  for (const serviceDate of dates) for (const trip of ds.trips) {
    if (!isServiceActive(ds.calendars[trip.serviceId], serviceDate)) continue;
    const p = patterns.get(trip.patternId), route = p && routes.get(p.routeId);
    // Direction IDs are route-specific. Outbound here means leaving PABT for a non-terminal stop.
    if (!p || !route?.trim() || !pabt.has(p.stopIds[0]!) || pabt.has(p.stopIds.at(-1)!)) continue;
    p.stopIds.forEach((id, i) => {
      const seconds = trip.times[i];
      if (!pabt.has(id) || !p.stopIds.slice(i + 1).some(stop => !pabt.has(stop)) || i === p.stopIds.length - 1 || p.noPickup?.includes(i) || trip.estimated?.includes(i) || seconds === undefined || !Number.isFinite(seconds)) return;
      if (serviceDate < today && seconds < 86400) return;
      if (serviceDate > today && seconds >= 3600) return;
      out.push({ tripInstanceId: tripInstanceId(trip.id, serviceDate), boardingIndex: i, route, at: tripTimeAt(ds, trip, serviceDate, i) });
    });
  }
  return out;
}
const addShape = (set: string[], value: unknown, shape: boolean) => {
  // Bounded identifier vocabulary only; never arbitrary upstream message/body text.
  if (typeof value !== 'string' || value.length > 64 || !/^[\w\s/:.\-]*$/.test(value)) return;
  const safe = shape ? value.replace(/\d/g, '9') : value;
  if (set.length < 10 && !set.includes(safe)) set.push(safe);
};
export function matchGateRows(rows: DvRow[], candidates: GateCandidate[], receivedAt: number, diagnostics = newGateDiagnostics(receivedAt)): Posting[] {
  const groups = new Map<string, { postings: Posting[]; count: number }>();
  for (const row of rows) {
    diagnostics.rowsSeen++;
    addShape(diagnostics.timingPoints, row.timing_point_id, false); addShape(diagnostics.scheduleShapes, row.sched_dep_time, true); addShape(diagnostics.gateShapes, row.lanegate, true);
    const drop = (reason: DropReason) => { diagnostics.drops[reason]++; };
    if (!PABT_TIMING_POINTS.includes(row.timing_point_id as string)) { drop('wrong-terminal'); continue; }
    const at = parseSchedDepTime(row.sched_dep_time);
    if (at === null) { drop('invalid-date'); continue; }
    const found = candidates.filter(c => c.route === row.public_route && c.at === at);
    if (found.length !== 1) { drop(found.length ? 'ambiguous' : 'unmatched'); continue; }
    const gate = parseLaneGate(typeof row.lanegate === 'string' ? row.lanegate : null);
    if (!gate) { drop('invalid-gate'); continue; }
    const c = found[0]!, key = JSON.stringify([c.tripInstanceId, c.boardingIndex]);
    const group = groups.get(key) ?? { postings: [], count: 0 };
    group.postings.push({ tripInstanceId: c.tripInstanceId, boardingIndex: c.boardingIndex, ...gate, source: 'njt-departurevision', receivedAt }); group.count++; groups.set(key, group);
  }
  const postings: Posting[] = [];
  for (const group of groups.values()) {
    const first = group.postings[0]!;
    if (group.postings.some(p => p.gate !== first.gate || p.door !== first.door)) diagnostics.drops.conflict += group.count;
    else { postings.push(first); diagnostics.matched += group.count; }
  }
  return postings;
}
