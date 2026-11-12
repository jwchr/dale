// Read-only schedule comparison for the owner-approved schedule check (Nov 12, 2026).
// Pure: takes two canonical datasets and returns aggregate counts and service dates only.
// Never returns trip IDs, stop IDs, times, names or coordinates.
// Plain Node runs this in the workflow, so import only time.ts (no extensionless imports).
import { addDays, weekdayIndex } from '../src/domain/time.ts';

/** Same rule as src/domain/schedule.ts isServiceActive; a unit test keeps them identical. */
export function isServiceActive(cal, ymd) {
  if (!cal) return false;
  if (cal.removed.includes(ymd)) return false;
  if (cal.added.includes(ymd)) return true;
  return ymd >= cal.start && ymd <= cal.end && cal.days[weekdayIndex(ymd)] === true;
}

const MAX_DIFFERENT_DATES = 14;

/**
 * Identity of one trip as live matching and riders see it: route, direction, headsign,
 * stops in order with their GTFS sequences and pickup/drop-off limits, departure times.
 */
function tripCores(ds) {
  const routes = new Map(ds.routes.map((r) => [r.id, r.shortName]));
  const patterns = new Map(ds.patterns.map((p) => [p.id, p]));
  const out = new Map();
  for (const trip of ds.trips) {
    const pattern = patterns.get(trip.patternId);
    if (!pattern) continue;
    out.set(trip.id, {
      route: routes.get(pattern.routeId) ?? '?',
      serviceId: trip.serviceId,
      core: JSON.stringify([routes.get(pattern.routeId) ?? '?', pattern.directionId, pattern.headsign ?? '', pattern.stopIds,
        pattern.stopSequences ?? null, pattern.noPickup ?? null, pattern.noDropOff ?? null, trip.times]),
      arrivals: JSON.stringify(trip.arrivals ?? null),
      stopIds: pattern.stopIds,
    });
  }
  return out;
}

function calendarRange(ds, cores) {
  let start, end;
  for (const id of new Set([...cores.values()].map((t) => t.serviceId))) {
    const cal = ds.calendars[id];
    if (!cal) continue;
    const dates = [...(cal.days.some(Boolean) ? [cal.start, cal.end] : []), ...cal.added].filter((d) => /^\d{8}$/.test(d));
    for (const d of dates) { if (!start || d < start) start = d; if (!end || d > end) end = d; }
  }
  return { start: start ?? null, end: end ?? null };
}

function activeOn(ds, cores, date) {
  const out = new Map();
  // Arrivals are included: the live bus-day fix closes its matching window on the final arrival.
  for (const [id, t] of cores) if (isServiceActive(ds.calendars[t.serviceId], date)) out.set(id, JSON.stringify([t.core, t.arrivals]));
  return out;
}

/** Same trips ignoring trip IDs: equal multisets of active trip signatures. */
function sameTimetable(a, b) {
  if (a.size !== b.size) return false;
  const counts = new Map();
  for (const v of a.values()) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const v of b.values()) { const n = counts.get(v); if (!n) return false; counts.set(v, n - 1); }
  return true;
}

/** Stops whose NJ Transit name, code or coordinates differ (city labels are Dale's own and excluded). */
function changedStops(deployed, candidate, ids) {
  const key = (st) => st && JSON.stringify([st.sourceName ?? st.name, st.code ?? null, st.lat ?? null, st.lon ?? null]);
  const a = new Map(deployed.stops.map((st) => [st.id, st])), b = new Map(candidate.stops.map((st) => [st.id, st]));
  return ids.filter((id) => key(a.get(id)) !== key(b.get(id))).length;
}

/** Days from today to the later of both calendars' last dates, between 60 and 366. */
export function windowDays(deployed, candidate, today) {
  const ends = [calendarRange(deployed, tripCores(deployed)).end, calendarRange(candidate, tripCores(candidate)).end].filter(Boolean);
  let days = 60;
  for (const end of ends) {
    if (end <= today) continue;
    const span = Math.round((Date.UTC(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6)) - Date.UTC(+today.slice(0, 4), +today.slice(4, 6) - 1, +today.slice(6))) / 86_400_000);
    days = Math.max(days, span);
  }
  return Math.min(days, 366);
}

const countBy = (cores) => {
  const by = {};
  for (const t of cores.values()) by[t.route] = (by[t.route] ?? 0) + 1;
  return Object.fromEntries(Object.entries(by).sort(([a], [b]) => a.localeCompare(b)));
};

/**
 * Compare the deployed canonical schedule with a candidate built the same way from
 * NJ Transit's current file, for each service date in [today - 1, today + days].
 */
export function compareSchedules(deployed, candidate, { today, days = 60 }) {
  if (!/^\d{8}$/.test(today) || !Number.isSafeInteger(days) || days < 1 || days > 366) throw new Error('invalid-window');
  const oldCores = tripCores(deployed), newCores = tripCores(candidate);
  let common = 0, coreChanged = 0, arrivalsOnlyChanged = 0;
  for (const [id, t] of oldCores) {
    const n = newCores.get(id);
    if (!n) continue;
    common++;
    if (n.core !== t.core) coreChanged++;
    else if (n.arrivals !== t.arrivals) arrivalsOnlyChanged++;
  }
  const stopSet = (cores) => new Set([...cores.values()].flatMap((t) => t.stopIds));
  const oldStops = stopSet(oldCores), newStops = stopSet(newCores);
  const dates = [];
  let firstDifferentDate = null, differentDateCount = 0, idOnlyDates = 0, firstTimetableDifferentDate = null, deployedTripDays = 0, candidateTripDays = 0;
  for (let i = -1; i <= days; i++) {
    const date = addDays(today, i);
    const a = activeOn(deployed, oldCores, date), b = activeOn(candidate, newCores, date);
    deployedTripDays += a.size; candidateTripDays += b.size;
    let onlyDeployed = 0, onlyCandidate = 0, changed = 0;
    for (const [id, core] of a) { const other = b.get(id); if (other === undefined) onlyDeployed++; else if (other !== core) changed++; }
    for (const id of b.keys()) if (!a.has(id)) onlyCandidate++;
    if (onlyDeployed || onlyCandidate || changed) {
      // Trip IDs matter for live matching, so an ID-only change still differs; flag it separately.
      const timetableSame = sameTimetable(a, b);
      differentDateCount++;
      firstDifferentDate ??= date;
      if (timetableSame) idOnlyDates++; else firstTimetableDifferentDate ??= date;
      if (dates.length < MAX_DIFFERENT_DATES) dates.push({ date, deployedTrips: a.size, candidateTrips: b.size, onlyDeployed, onlyCandidate, changed, timetableSame });
    }
  }
  const todayDeployed = activeOn(deployed, oldCores, today).size, todayCandidate = activeOn(candidate, newCores, today).size;
  return {
    v: 1,
    window: { from: addDays(today, -1), to: addDays(today, days), today },
    deployed: { feedVersion: deployed.meta.feedVersion, trips: oldCores.size, tripsByRoute: countBy(oldCores), stops: oldStops.size, calendar: calendarRange(deployed, oldCores), tripsToday: todayDeployed },
    candidate: { feedVersion: candidate.meta.feedVersion, trips: newCores.size, tripsByRoute: countBy(newCores), stops: newStops.size, calendar: calendarRange(candidate, newCores), tripsToday: todayCandidate },
    trips: { common, onlyDeployed: oldCores.size - common, onlyCandidate: newCores.size - common, coreChanged, arrivalsOnlyChanged },
    stops: { common: [...oldStops].filter((s) => newStops.has(s)).length, changed: changedStops(deployed, candidate, [...oldStops].filter((s) => newStops.has(s))), onlyDeployed: [...oldStops].filter((s) => !newStops.has(s)).length, onlyCandidate: [...newStops].filter((s) => !oldStops.has(s)).length },
    serviceDates: { compared: days + 2, different: differentDateCount, idOnlyDates, firstDifferentDate, firstTimetableDifferentDate, deployedTripDays, candidateTripDays, firstDifferences: dates },
  };
}

/** One plain-English line for the owner, derived only from the summary. */
export function plainVerdict(s) {
  const { serviceDates: d } = s;
  if (!d.deployedTripDays || !d.candidateTripDays) return `No comparison possible: from ${s.window.from} to ${s.window.to} the deployed schedule has ${d.deployedTripDays} active trip-days and NJ Transit's current file has ${d.candidateTripDays} on Dale's routes.`;
  if (!s.candidate.tripsToday && s.deployed.tripsToday) return `NJ Transit's current file has no trips on Dale's routes for today (${s.window.today}); the deployed schedule has ${s.deployed.tripsToday}.`;
  const stops = s.stops.changed || s.stops.onlyDeployed || s.stops.onlyCandidate ? ` Stop details differ: ${s.stops.changed} changed, ${s.stops.onlyDeployed} removed, ${s.stops.onlyCandidate} added.` : '';
  if (!d.different) return `For every service date from ${s.window.from} to ${s.window.to}, the trips on Dale's routes are identical (trip IDs, route, direction, stops, departure and arrival times).${stops}`;
  const kind = d.firstTimetableDifferentDate ? `the timetable itself first differs on ${d.firstTimetableDifferentDate}` : 'only trip IDs differ; the timetable is the same';
  return `Trips on Dale's routes first differ on ${d.firstDifferentDate} (${kind}); ${d.different} of ${d.compared} service dates from ${s.window.from} to ${s.window.to} differ.${stops}`;
}
