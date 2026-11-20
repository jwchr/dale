// Wider official schedule for "Get me home" (#32) and official fare data for #31.
// This is a separate delivery file next to the corridor schedule. It is never part of the corridor
// schedule, the live poller or the history collector's context, so collection stays corridor-only.
// Pure functions over GTFS text; scripts/prepare-live-worker.mjs writes the result.
import { RESCUE_SCHEDULE_MAX_BYTES, RESCUE_SCHEDULE_KIND } from '../src/domain/rescueSchedule.ts';
import { buildDataset, filterCsvByColumn, parseCsv } from './gtfs-lib.mjs';

/** Upper bound on extra routes, so a stop shared by many routes cannot grow the file without limit. */
export const RESCUE_MAX_ROUTES = 12;
/** Terminal stops are shared by most routes; sharing only a terminal does not make a route a way home. */
const TERMINAL = /PORT AUTHORITY/i;
const FARE_V2_FILES = ['fare_products.txt', 'fare_leg_rules.txt', 'fare_media.txt', 'fare_transfer_rules.txt', 'areas.txt', 'stop_areas.txt'];
const byNumber = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/**
 * Routes that share at least `minSharedStops` non-terminal stops with the corridor, chosen from the
 * feed's own stop_times (never from route numbers). `onlyShortNames` optionally narrows the choice.
 * Frequency-based routes are skipped: their trips have no exact times to show.
 */
export function selectRescueRoutes(files, { corridorRouteIds, onlyShortNames, maxRoutes = RESCUE_MAX_ROUTES, minSharedStops = 1 }) {
  for (const name of ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt']) if (files[name] === undefined) throw new Error(`missing ${name}`);
  const corridor = new Set(corridorRouteIds);
  const routes = parseCsv(files['routes.txt']);
  const corridorNames = new Set(routes.filter((r) => corridor.has(r.route_id)).map((r) => (r.route_short_name || '').toUpperCase()));
  const routeOfTrip = new Map(parseCsv(files['trips.txt']).map((t) => [t.trip_id, t.route_id]));
  const corridorTrips = new Set([...routeOfTrip].filter(([, routeId]) => corridor.has(routeId)).map(([tripId]) => tripId));
  const terminals = new Set(parseCsv(files['stops.txt']).filter((s) => TERMINAL.test(s.stop_name || '')).map((s) => s.stop_id));
  const corridorStops = new Set(parseCsv(filterCsvByColumn(files['stop_times.txt'], 'trip_id', corridorTrips)).map((st) => st.stop_id));
  const candidates = new Set([...corridorStops].filter((id) => !terminals.has(id)));

  const sharedByRoute = new Map();
  for (const st of parseCsv(filterCsvByColumn(files['stop_times.txt'], 'stop_id', candidates))) {
    const routeId = routeOfTrip.get(st.trip_id);
    if (!routeId || corridor.has(routeId)) continue;
    let set = sharedByRoute.get(routeId);
    if (!set) sharedByRoute.set(routeId, (set = new Set()));
    set.add(st.stop_id);
  }
  const frequencyRoutes = new Set(files['frequencies.txt'] ? parseCsv(files['frequencies.txt']).map((f) => routeOfTrip.get(f.trip_id)).filter(Boolean) : []);

  // buildDataset selects by short name, so group the feed's route IDs the same way.
  const groups = new Map();
  for (const r of routes) {
    const shared = sharedByRoute.get(r.route_id);
    if (!shared) continue;
    const shortName = (r.route_short_name || '').trim();
    const key = shortName.toUpperCase();
    if (corridorNames.has(key)) continue;
    const label = shortName || r.route_id;
    let g = groups.get(key || `#${r.route_id}`);
    if (!g) groups.set(key || `#${r.route_id}`, (g = { shortName: label, routeIds: [], stops: new Set(), named: !!shortName, frequency: false }));
    g.routeIds.push(r.route_id);
    shared.forEach((id) => g.stops.add(id));
    if (frequencyRoutes.has(r.route_id)) g.frequency = true;
  }
  const allow = onlyShortNames?.length ? new Set(onlyShortNames.map((s) => s.toUpperCase())) : undefined;
  const ranked = [...groups.values()].map((g) => ({ shortName: g.shortName, routeIds: g.routeIds.sort(), sharedStops: g.stops.size, named: g.named, frequency: g.frequency }))
    .sort((a, b) => b.sharedStops - a.sharedStops || byNumber(a.shortName, b.shortName));
  const selected = [], skipped = [];
  for (const g of ranked) {
    const reason = !g.named ? 'no_short_name' : g.frequency ? 'frequency_based' : g.sharedStops < minSharedStops ? 'too_few_shared_stops'
      : allow && !allow.has(g.shortName.toUpperCase()) ? 'not_in_allow_list' : selected.length >= maxRoutes ? 'over_limit' : undefined;
    const row = { shortName: g.shortName, routeIds: g.routeIds, sharedStops: g.sharedStops };
    if (reason) skipped.push({ ...row, reason }); else selected.push(row);
  }
  return { selected, skipped, corridorStops: corridorStops.size, terminalStopsIgnored: [...corridorStops].filter((id) => terminals.has(id)).length };
}

/**
 * Official GTFS fares (fare_attributes.txt, fare_rules.txt, stops.txt zone_id) for the given routes
 * and stops, carried as published. When any part is missing the result says what is missing and
 * carries nothing: zones are never derived from distance or route numbers.
 */
export function officialFares(files, { routeIds, stopIds, sourceFileNames = Object.keys(files) }) {
  const names = new Set(sourceFileNames);
  const unread = FARE_V2_FILES.filter((n) => names.has(n));
  const extra = unread.length ? { unreadFareFiles: unread } : {};
  const attrs = files['fare_attributes.txt'] ? parseCsv(files['fare_attributes.txt']) : [];
  const rules = files['fare_rules.txt'] ? parseCsv(files['fare_rules.txt']) : [];
  const served = parseCsv(files['stops.txt'] ?? '').filter((s) => stopIds.has(s.stop_id));
  const stopZones = {};
  for (const s of served) if (s.zone_id) stopZones[s.stop_id] = s.zone_id;
  const missing = [];
  if (!attrs.length) missing.push('fare_attributes.txt');
  if (!rules.length) missing.push('fare_rules.txt');
  if (!Object.keys(stopZones).length) missing.push('stops.txt zone_id');
  if (missing.length) return { state: 'absent', missing, ...extra };

  const zones = new Set(Object.values(stopZones));
  const keptRules = rules
    .filter((r) => (!r.route_id || routeIds.has(r.route_id)) && [r.origin_id, r.destination_id, r.contains_id].every((z) => !z || zones.has(z)))
    .map((r) => ({ fareId: r.fare_id, ...(r.route_id ? { routeId: r.route_id } : {}), ...(r.origin_id ? { originZone: r.origin_id } : {}),
      ...(r.destination_id ? { destinationZone: r.destination_id } : {}), ...(r.contains_id ? { containsZone: r.contains_id } : {}) }));
  const used = new Set(keptRules.map((r) => r.fareId));
  const attributes = [];
  for (const a of attrs) {
    if (!used.has(a.fare_id)) continue;
    // Carried exactly as published; a row Dale cannot read means no fares, never a guessed one.
    if (!/^\d+(\.\d+)?$/.test(a.price ?? '') || !/^[A-Z]{3}$/.test(a.currency_type ?? '') || !['0', '1'].includes(a.payment_method)
      || !['', '0', '1', '2'].includes(a.transfers ?? '') || (a.transfer_duration && !/^\d+$/.test(a.transfer_duration))) {
      return { state: 'absent', missing: ['fare_attributes.txt (unreadable row)'], ...extra };
    }
    attributes.push({ fareId: a.fare_id, price: a.price, currency: a.currency_type, paymentMethod: Number(a.payment_method),
      transfers: a.transfers === '' ? null : Number(a.transfers), ...(a.transfer_duration ? { transferDuration: Number(a.transfer_duration) } : {}) });
  }
  if (!keptRules.length) return { state: 'absent', missing: ['fare_rules.txt rows for these routes'], ...extra };
  if (keptRules.some((r) => !attributes.some((a) => a.fareId === r.fareId))) return { state: 'absent', missing: ['fare_attributes.txt rows for these rules'], ...extra };
  return { state: 'present', source: 'NJ Transit GTFS fare_attributes.txt, fare_rules.txt and stops.txt zone_id', stopZones, attributes, rules: keptRules,
    stopsWithoutZone: served.length - Object.keys(stopZones).length, ...extra };
}

/**
 * The wider schedule: routes chosen by stop overlap with the already-built corridor, with every
 * served stop's coordinates, plus official fares for corridor and wider routes when the feed has them.
 * Returns { schedule, report }; schedule is null when nothing was chosen or it would be too large.
 * The report holds aggregate counts and route numbers only.
 */
export function buildRescueSchedule(files, corridorDs, { onlyShortNames, maxRoutes, builtAt = new Date().toISOString(), sourceFileNames } = {}) {
  const corridorRouteIds = [...new Set(corridorDs.routes.map((r) => r.feedRouteId ?? r.id))];
  const selection = selectRescueRoutes(files, { corridorRouteIds, onlyShortNames, maxRoutes });
  const skipped = selection.skipped.map(({ shortName, sharedStops, reason }) => ({ shortName, sharedStops, reason }));
  const report = { selected: selection.selected.map(({ shortName, sharedStops }) => ({ shortName, sharedStops })), skipped,
    corridorStops: selection.corridorStops, terminalStopsIgnored: selection.terminalStopsIgnored };
  if (!selection.selected.length) return { schedule: null, report: { ...report, state: 'none_selected' } };

  const ds = buildDataset(files, { routeShortNames: selection.selected.map((r) => r.shortName), feedVersion: corridorDs.meta.feedVersion,
    builtAt, source: corridorDs.meta.source, splitVariants: true, scheduledOnly: true, patternPrefix: 'R' });
  const routeIds = new Set([...corridorRouteIds, ...selection.selected.flatMap((r) => r.routeIds)]);
  const stopIds = new Set([...corridorDs.stops.map((s) => s.id), ...ds.stops.map((s) => s.id)]);
  const fares = officialFares(files, { routeIds, stopIds, sourceFileNames });
  const schedule = { ...ds, meta: { ...ds.meta, timezone: corridorDs.meta.timezone,
    rescue: { kind: RESCUE_SCHEDULE_KIND, chosenBy: 'shared stops with the corridor', routes: report.selected, skipped } }, officialFares: fares };
  const bytes = Buffer.byteLength(JSON.stringify(schedule));
  const summary = { ...report, routes: ds.routes.length, trips: ds.trips.length, stops: ds.stops.length,
    stopsWithLocation: ds.stops.filter((s) => typeof s.lat === 'number').length, fares: fares.state, bytes };
  if (bytes > RESCUE_SCHEDULE_MAX_BYTES) return { schedule: null, report: { ...summary, state: 'too_large' } };
  return { schedule, report: { ...summary, state: 'ready' } };
}
