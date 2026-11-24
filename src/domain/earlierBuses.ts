import { CONFIDENCE_ROUTES } from './arrivalConfidence';
import { isServiceActive, tripArrivalAt, tripTimeAt } from './schedule';
import { addDays, localYmd } from './time';
import { validServiceDate, type LivePrediction } from './liveBus';
import type { Dataset, Pattern, Trip } from './types';
import { boardIndex, placeIndex } from './place';

export interface EarlierQuery { route: string; stop: string; direction: 0 | 1 }
export interface EarlierTime {
  scheduledAt: number | null;
  evidence: { at: number; sourceAt: number; kind: 'gps' | 'prediction'; minutesLate: number | null } | null;
}
export interface EarlierBus { route: string; direction: 0 | 1; stop: EarlierTime; portAuthority: EarlierTime | null }
export interface EarlierAnswer {
  v: 1; query: EarlierQuery; generatedAt: number; coverageStart: number; through: number; gap: boolean; items: EarlierBus[];
}
/** Private projection. No vehicle IDs or coordinates, even here. Never serialize it into a public answer. */
export interface EarlierTrip {
  progress?: [number, number];
  gps: Record<string, number>;
  predictions: Record<string, LivePrediction>;
  updatedAt?: number;
}
export interface EarlierState {
  v: 1; context: string; checkpoint: number; coverageStart: number; through: number; gap: boolean;
  trips: Record<string, EarlierTrip>;
}
export function parseEarlierQuery(params: URLSearchParams, ds: Dataset): EarlierQuery | undefined {
  if ([...params.keys()].length !== 3 || !['route', 'stop', 'direction'].every(k => params.getAll(k).length === 1)) return;
  const route = params.get('route')!, stop = params.get('stop')!, direction = params.get('direction');
  if (!CONFIDENCE_ROUTES.includes(route) || !['0', '1'].includes(direction!)) return;
  const routes = new Set(ds.routes.filter(r => r.shortName === route).map(r => r.id));
  if (!ds.patterns.some(p => routes.has(p.routeId) && p.directionId === Number(direction) && placeIndex(ds, p, stop) >= 0)) return;
  return { route, stop, direction: Number(direction) as 0 | 1 };
}

export function createEarlierDomain(ds: Dataset) {
  const trips = new Map(ds.trips.map(t => [t.id, t])), patterns = new Map(ds.patterns.map(p => [p.id, p]));
  const routes = new Map(ds.routes.map(r => [r.id, r]));
  const pabt = new Set(ds.stops.filter(s => s.terminal === 'PABT').map(s => s.id));
  function match(id: string): { trip: Trip; pattern: Pattern; date: string; route: string } | undefined {
    const at = id.lastIndexOf('@'), date = id.slice(at + 1), trip = trips.get(id.slice(0, at));
    const pattern = trip && patterns.get(trip.patternId), route = pattern && routes.get(pattern.routeId);
    if (!trip || !pattern || !route || !CONFIDENCE_ROUTES.includes(route.shortName) || !validServiceDate(date)
      || !ds.calendars[trip.serviceId] || !isServiceActive(ds.calendars[trip.serviceId]!, date)) return;
    return { trip, pattern, date, route: route.shortName };
  }
  function keepAt(now: number) {
    const today = localYmd(now, ds.meta.timezone), yesterday = addDays(today, -1);
    return (id: string) => {
      const m = match(id);
      if (!m || m.date < yesterday || m.date > today) return;
      return m;
    };
  }
  /** Return retained evidence without mutating the input; yesterday's service may run overnight. */
  function prune(rows: EarlierState['trips'], through: number): EarlierState['trips'] {
    const keep = keepAt(through);
    return Object.fromEntries(Object.entries(rows).filter(([id]) => keep(id)));
  }
  function fold(state: EarlierState, raw: unknown, now: number) {
    const batch = raw as { records?: { observation?: { tripInstanceId?: string; observedAt?: number; stopCall?: { status: string; stopIndex: number; stopId: string } } }[];
      tripChanges?: { tripInstanceId: string; observedAt: number; cancelled?: boolean; skippedStops?: number[]; predictions?: LivePrediction[] }[] };
    const keep = keepAt(now);
    const validAt = (at: unknown): at is number => typeof at === 'number' && Number.isSafeInteger(at) && at > 0 && at <= now;
    for (const r of batch.records ?? []) {
      const o = r.observation, call = o?.stopCall;
      if (!o || typeof o.tripInstanceId !== 'string' || !validAt(o.observedAt) || !call || call.status !== 'stopped_at') continue;
      const m = keep(o.tripInstanceId);
      if (!m || m.pattern.stopIds[call.stopIndex] !== call.stopId) continue;
      const row = state.trips[o.tripInstanceId] ??= { gps: {}, predictions: {} };
      row.gps[call.stopIndex] = Math.min(row.gps[call.stopIndex] ?? Infinity, o.observedAt);
      if (!row.progress || call.stopIndex > row.progress[1] || (call.stopIndex === row.progress[1] && o.observedAt > row.progress[0]))
        row.progress = [o.observedAt, call.stopIndex];
    }
    for (const u of batch.tripChanges ?? []) {
      if (typeof u.tripInstanceId !== 'string' || !validAt(u.observedAt)) continue;
      const m = keep(u.tripInstanceId); if (!m) continue;
      const row = state.trips[u.tripInstanceId] ??= { gps: {}, predictions: {} };
      if (u.observedAt < (row.updatedAt ?? 0)) continue;
      row.updatedAt = u.observedAt;
      // Cancellation/skips invalidate predictions, never observations. Missing reports do neither.
      if (u.cancelled) { row.predictions = {}; continue; }
      for (const index of u.skippedStops ?? []) { delete row.predictions[`${index}:arrival`]; delete row.predictions[`${index}:departure`]; }
      for (const p of u.predictions ?? []) {
        if (!Number.isSafeInteger(p.stopIndex) || !m.pattern.stopIds[p.stopIndex] || !['arrival', 'departure'].includes(p.kind)
          || !validAt(p.observedAt) || p.observedAt !== u.observedAt || !Number.isSafeInteger(p.at) || p.at <= 0 || (u.skippedStops ?? []).includes(p.stopIndex)) continue;
        const key = `${p.stopIndex}:${p.kind}`;
        if (p.observedAt > (row.predictions[key]?.observedAt ?? 0)) row.predictions[key] = { stopIndex: p.stopIndex, kind: p.kind, at: p.at, observedAt: p.observedAt };
      }
    }
    state.trips = prune(state.trips, now);
  }
  function answer(state: EarlierState, query: EarlierQuery, now: number): EarlierAnswer {
    const today = localYmd(now, ds.meta.timezone);
    const items: { scheduled: number; bus: EarlierBus }[] = [];
    for (const [id, row] of Object.entries(state.trips)) {
      const m = match(id); if (!m || m.route !== query.route || m.pattern.directionId !== query.direction) continue;
      // Any Port Authority stop ID is the rider's Port Authority (audit, Nov 24, 2026): late trips use other gates.
      const index = boardIndex(ds, m.pattern, query.stop);
      if (index < 0 || !row.progress || row.progress[1] <= index) continue;
      const scheduled = tripTimeAt(ds, m.trip, m.date, index);
      if (localYmd(scheduled, ds.meta.timezone) !== today || scheduled > now) continue;
      function time(i: number, arrival: boolean): EarlierTime {
        const scheduledAt = m!.trip.estimated?.includes(i) ? null : arrival ? tripArrivalAt(ds, m!.trip, m!.date, i) ?? null : tripTimeAt(ds, m!.trip, m!.date, i);
        const gps = row.gps[i], p = row.predictions[`${i}:${arrival ? 'arrival' : 'departure'}`];
        const evidence = gps !== undefined ? { at: gps, sourceAt: gps, kind: 'gps' as const }
          : p ? { at: p.at, sourceAt: p.observedAt, kind: 'prediction' as const } : null;
        return { scheduledAt, evidence: evidence && { ...evidence, minutesLate: scheduledAt === null ? null : Math.round((evidence.at - scheduledAt) / 60_000) } };
      }
      // The last Port Authority call: live arrival evidence is kept only for the final terminal call, never the drop-off before it.
      let terminal = -1;
      for (let i = m.pattern.stopIds.length - 1; i > index; i--) if (pabt.has(m.pattern.stopIds[i]!)) { terminal = i; break; }
      items.push({ scheduled, bus: { route: m.route, direction: query.direction, stop: time(index, false), portAuthority: terminal >= 0 ? time(terminal, true) : null } });
    }
    items.sort((a, b) => b.scheduled - a.scheduled);
    return { v: 1, query, generatedAt: now, coverageStart: state.coverageStart, through: state.through, gap: state.gap, items: items.slice(0, 5).map(i => i.bus) };
  }
  return { fold, answer, prune };
}

/** Fail closed on a mismatched/malformed answer before rendering any time as history. */
export function parseEarlierAnswer(raw: unknown, query: EarlierQuery): EarlierAnswer | undefined {
  const a = raw as EarlierAnswer | null;
  const at = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  const time = (t: EarlierTime) => !!t && (t.scheduledAt === null || at(t.scheduledAt)) && (t.evidence === null
    || (!!t.evidence && ['gps', 'prediction'].includes(t.evidence.kind) && at(t.evidence.at) && at(t.evidence.sourceAt)
      && t.evidence.sourceAt <= a!.generatedAt && (t.evidence.kind !== 'gps' || t.evidence.at === t.evidence.sourceAt)
      && t.evidence.minutesLate === (t.scheduledAt === null ? null : Math.round((t.evidence.at - t.scheduledAt) / 60_000))));
  if (!a || a.v !== 1 || !a.query || a.query.route !== query.route || a.query.stop !== query.stop || a.query.direction !== query.direction
    || !at(a.generatedAt) || !at(a.coverageStart) || !at(a.through) || a.coverageStart > a.through || a.through > a.generatedAt
    || typeof a.gap !== 'boolean' || !Array.isArray(a.items) || a.items.length > 5
    || !a.items.every(i => i && i.route === query.route && i.direction === query.direction && time(i.stop) && (i.portAuthority === null || time(i.portAuthority)))) return;
  return a;
}
