// Aggregate fare-data inventory of an NJ Transit GTFS file (#31): which fare files exist, their row
// counts, and how many corridor stops carry a fare zone. Counts only: no zone ids, prices or stop ids.
import { parseCsv } from './gtfs-lib.mjs';

export const FARE_FILES = ['fare_attributes.txt', 'fare_rules.txt', 'fare_media.txt', 'fare_products.txt', 'fare_leg_rules.txt', 'fare_leg_join_rules.txt',
  'fare_transfer_rules.txt', 'areas.txt', 'stop_areas.txt', 'networks.txt', 'route_networks.txt', 'timeframes.txt', 'rider_categories.txt'];

/** Standard GTFS schedule file names. Any other name in the ZIP is only counted, never printed. */
const GTFS_FILES = new Set(['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt',
  'shapes.txt', 'frequencies.txt', 'transfers.txt', 'pathways.txt', 'levels.txt', 'location_groups.txt', 'location_group_stops.txt',
  'locations.geojson', 'booking_rules.txt', 'translations.txt', 'feed_info.txt', 'attributions.txt', ...FARE_FILES]);

/** `entryNames`: every file name in the ZIP. `files`: decoded text of stops.txt and any fare files. `stopIds`: the corridor's stops. */
export function fareInventory(entryNames, files, stopIds) {
  const all = [...new Set(entryNames.map((n) => n.split('/').pop()).filter(Boolean))];
  const names = all.filter((n) => GTFS_FILES.has(n)).sort();
  const rows = Object.fromEntries(FARE_FILES.filter((f) => files[f] !== undefined).map((f) => [f, parseCsv(files[f]).length]));
  const stops = files['stops.txt'] ? parseCsv(files['stops.txt']) : [];
  const ids = new Set(stopIds);
  const corridor = stops.filter((s) => ids.has(s.stop_id));
  const zoneColumn = stops.length > 0 && Object.prototype.hasOwnProperty.call(stops[0], 'zone_id');
  const zoned = corridor.filter((s) => (s.zone_id ?? '').trim() !== '');
  return {
    files: names,
    otherFiles: all.length - names.length,
    fareRows: rows,
    stopsZoneColumn: zoneColumn,
    corridorStops: corridor.length,
    corridorStopsWithZone: zoned.length,
    distinctCorridorZones: new Set(zoned.map((s) => s.zone_id.trim())).size,
  };
}
