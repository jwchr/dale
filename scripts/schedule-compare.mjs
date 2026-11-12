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

/** Rider-relevant identity of one trip: route, direction, stops in order, departure times. */
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
      core: JSON.stringify([routes.get(pattern.routeId) ?? '?', pattern.directionId, pattern.stopIds, trip.times]),
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
  let firstDifferentDate = null, differentDateCount = 0;
  for (let i = -1; i <= days; i++) {
    const date = addDays(today, i);
    const a = activeOn(deployed, oldCores, date), b = activeOn(candidate, newCores, date);
    let onlyDeployed = 0, onlyCandidate = 0, changed = 0;
    for (const [id, core] of a) { const other = b.get(id); if (other === undefined) onlyDeployed++; else if (other !== core) changed++; }
    for (const id of b.keys()) if (!a.has(id)) onlyCandidate++;
    if (onlyDeployed || onlyCandidate || changed) {
      differentDateCount++;
      firstDifferentDate ??= date;
      if (dates.length < MAX_DIFFERENT_DATES) dates.push({ date, deployedTrips: a.size, candidateTrips: b.size, onlyDeployed, onlyCandidate, changed });
    }
  }
  const todayDeployed = activeOn(deployed, oldCores, today).size, todayCandidate = activeOn(candidate, newCores, today).size;
  return {
    v: 1,
    window: { from: addDays(today, -1), to: addDays(today, days), today },
    deployed: { feedVersion: deployed.meta.feedVersion, trips: oldCores.size, tripsByRoute: countBy(oldCores), stops: oldStops.size, calendar: calendarRange(deployed, oldCores), tripsToday: todayDeployed },
    candidate: { feedVersion: candidate.meta.feedVersion, trips: newCores.size, tripsByRoute: countBy(newCores), stops: newStops.size, calendar: calendarRange(candidate, newCores), tripsToday: todayCandidate },
    trips: { common, onlyDeployed: oldCores.size - common, onlyCandidate: newCores.size - common, coreChanged, arrivalsOnlyChanged },
    stops: { common: [...oldStops].filter((s) => newStops.has(s)).length, onlyDeployed: [...oldStops].filter((s) => !newStops.has(s)).length, onlyCandidate: [...newStops].filter((s) => !oldStops.has(s)).length },
    serviceDates: { compared: days + 2, different: differentDateCount, firstDifferentDate, firstDifferences: dates },
  };
}

/** One plain-English line for the owner, derived only from the summary. */
export function plainVerdict(s) {
  const { serviceDates: d } = s;
  if (!s.candidate.tripsToday && s.deployed.tripsToday) return `NJ Transit's current file has no trips on Dale's routes for today (${s.window.today}); the deployed schedule has ${s.deployed.tripsToday}.`;
  if (!d.different) return `For every service date from ${s.window.from} to ${s.window.to}, the trips on Dale's routes are identical (route, direction, stops, departure and arrival times).`;
  return `Trips on Dale's routes first differ on ${d.firstDifferentDate}; ${d.different} of ${d.compared} service dates from ${s.window.from} to ${s.window.to} differ.`;
}
