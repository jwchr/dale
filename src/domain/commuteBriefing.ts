import { boardIndex, dropIndex } from './place';
import { departuresOn, tripTimeAt } from './schedule';
import { isNjtHoliday } from './holidays';
import { addDays, localYmd } from './time';
import type { Dataset, Departure } from './types';

export interface BriefingSelection {
  fromStopId: string; toStopId: string; routeIds: string[]; date: string;
  /** Explicit instants only. Omitted means the whole selected calendar day, never a guessed commute. */
  window?: { start: number; end: number };
}

/** Invalid or future source clocks never become fresh just because Dale received them now. */
export function sourceAge(at: string | number | undefined, now: number): number | undefined {
  const value = typeof at === 'string' ? Date.parse(at) : at;
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= now ? now - value : undefined;
}

export function briefingSelectionKnown(ds: Dataset, selection: Pick<BriefingSelection, 'fromStopId' | 'toStopId' | 'routeIds'>) {
  return [selection.fromStopId, selection.toStopId].every(id => ds.stops.some(s => s.id === id))
    && selection.routeIds.every(id => ds.routes.some(r => r.id === id));
}

export function commuteBriefing(ds: Dataset, selection: BriefingSelection) {
  const { date, fromStopId, toStopId, routeIds, window } = selection;
  const selectionKnown = briefingSelectionKnown(ds, selection);
  const patterns = ds.patterns.filter(p => {
    const from = boardIndex(ds, p, fromStopId), to = from < 0 ? -1 : dropIndex(ds, p, toStopId, from + 1);
    return (!routeIds.length || routeIds.includes(p.routeId)) && from >= 0 && to > from
      && !p.noPickup?.includes(from) && !p.noDropOff?.includes(to);
  });
  const trips = ds.trips.filter(t => patterns.some(p => p.id === t.patternId));
  const calendars = [...new Set(trips.map(t => t.serviceId))].flatMap(id => ds.calendars[id] ? [ds.calendars[id]!] : []);
  const validWindow = !window || (Number.isFinite(window.start) && Number.isFinite(window.end) && window.start < window.end);
  const departures = validWindow ? departuresOn(ds, { date, stopId: fromStopId, toStopId, routeIds })
    .filter(d => !window || (d.departs >= window.start && d.departs < window.end)) : [];
  // Prove coverage for every service date that could contribute a departure on this local day.
  // This includes >24:00 and GTFS noon-minus-12h on DST dates. Missing coverage is never no service.
  const coverage = trips.flatMap(trip => {
    const pattern = patterns.find(p => p.id === trip.patternId)!;
    const index = boardIndex(ds, pattern, fromStopId), cal = ds.calendars[trip.serviceId];
    if (!cal) return [false];
    return [-1, 0, 1].flatMap(delta => {
      const serviceDate = addDays(date, delta);
      if (localYmd(tripTimeAt(ds, trip, serviceDate, index), ds.meta.timezone) !== date) return [];
      if (cal.added.includes(serviceDate) || cal.removed.includes(serviceDate)) return [true];
      // Exception-only services are inactive outside their listed dates. They supply no coverage
      // there. A recurring trip must be covered by its own calendar, never another service's range.
      if (cal.start > cal.end) return [];
      return [serviceDate >= cal.start && serviceDate <= cal.end];
    });
  });
  const covered = coverage.length > 0 && coverage.every(Boolean);
  const printedHoliday = !!ds.meta.transcribed && isNjtHoliday(date);
  const state: 'printed-holiday' | 'unknown' | 'scheduled' | 'no-service' = !selectionKnown || !validWindow || !covered ? 'unknown' : printedHoliday ? 'printed-holiday' : departures.length ? 'scheduled' : 'no-service';
  return { state, selectionKnown, departures: printedHoliday ? [] : departures, patterns,
    routeNames: ds.routes.filter(r => patterns.some(p => p.routeId === r.id)).map(r => r.shortName),
    validity: calendars.flatMap(cal => cal.start <= cal.end ? [{ start: cal.start, end: cal.end }] : [...cal.added, ...cal.removed].map(d => ({ start: d, end: d }))),
  };
}

// Future advisory adapters must supply documented selectors and instants. This pure model performs no I/O.
export interface AdvisorySelector { routeId?: string; stopId?: string; directionId?: 0 | 1; ambiguous?: boolean }
export function advisoryScope(selectors: AdvisorySelector[], ds: Dataset, selection: BriefingSelection): 'match' | 'unrelated' | 'uncertain' {
  if (!selectors.length) return 'uncertain'; // An absent selector is not proof of agency-wide coverage.
  const patterns = commuteBriefing(ds, selection).patterns;
  if (!patterns.length) return 'uncertain';
  let uncertain = false;
  for (const s of selectors) {
    const possible = patterns.some(p => (!s.routeId || p.routeId === s.routeId) && (s.directionId === undefined || p.directionId === s.directionId)
      && (!s.stopId || p.stopIds.slice(boardIndex(ds, p, selection.fromStopId), dropIndex(ds, p, selection.toStopId, boardIndex(ds, p, selection.fromStopId) + 1) + 1).includes(s.stopId)));
    if (!possible) continue;
    if (s.ambiguous) uncertain = true; else return 'match';
  }
  return uncertain ? 'uncertain' : 'unrelated';
}
export const activeDuring = (period: { start: number; end?: number }, window: { start: number; end: number }) =>
  Number.isFinite(period.start) && (period.end === undefined || (Number.isFinite(period.end) && period.end > period.start))
  && window.start < window.end && period.start < window.end && (period.end === undefined || period.end > window.start);

export type AlertsCheck = { state: 'disabled' | 'unverified' | 'timeout' | 'denied' | '429' | 'malformed' | 'offline' | 'failed'; attemptedAt?: number }
  | { state: 'success'; verified: boolean; covered: boolean; checkedAt: number; updatedAt?: number; expiresAt: number; matching: number };
export function alertsStatus(check: AlertsCheck, now: number): 'unavailable' | 'empty' | 'notices' {
  if (check.state !== 'success' || !check.verified || !check.covered || sourceAge(check.checkedAt, now) === undefined
    || now - check.checkedAt > 60_000 || !Number.isFinite(check.expiresAt) || check.expiresAt <= now
    || (check.updatedAt !== undefined && (sourceAge(check.updatedAt, now) === undefined || now - check.updatedAt > 60_000))) return 'unavailable';
  return Number.isInteger(check.matching) && check.matching >= 0 ? check.matching === 0 ? 'empty' : 'notices' : 'unavailable';
}
export interface GateAssignment { tripId: string; serviceDate: string; gate: string; observedAt: number; source: string; kind: 'official' | 'published' }
export function exactGateChange(before: GateAssignment | undefined, after: GateAssignment | undefined, dep: Pick<Departure, 'tripId' | 'serviceDate'>, now: number) {
  const matches = (g: GateAssignment | undefined) => g && g.kind === 'official' && g.tripId === dep.tripId && g.serviceDate === dep.serviceDate
    && g.gate.trim() && g.source.trim() && sourceAge(g.observedAt, now) !== undefined;
  return matches(before) && matches(after) && after!.observedAt > before!.observedAt && after!.gate.trim() !== before!.gate.trim() ? { before: before!, after: after! } : undefined;
}
