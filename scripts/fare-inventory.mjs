// Aggregate fare-data inventory of an NJ Transit GTFS file (#31): which fare files exist, their row
// counts, and how many corridor stops carry a fare zone. Counts only: no zone ids, prices or stop ids.
import { parseCsv } from './gtfs-lib.mjs';

export const FARE_FILES = ['fare_attributes.txt', 'fare_rules.txt', 'fare_media.txt', 'fare_products.txt', 'fare_leg_rules.txt',
  'fare_transfer_rules.txt', 'areas.txt', 'stop_areas.txt', 'networks.txt', 'route_networks.txt', 'timeframes.txt', 'rider_categories.txt'];

/** `entryNames`: every file name in the ZIP. `files`: decoded text of stops.txt and any fare files. `stopIds`: the corridor's stops. */
export function fareInventory(entryNames, files, stopIds) {
  const names = [...new Set(entryNames.map((n) => n.split('/').pop()))].sort();
  const rows = Object.fromEntries(FARE_FILES.filter((f) => files[f] !== undefined).map((f) => [f, parseCsv(files[f]).length]));
  const stops = files['stops.txt'] ? parseCsv(files['stops.txt']) : [];
  const ids = new Set(stopIds);
  const corridor = stops.filter((s) => ids.has(s.stop_id));
  const zoneColumn = stops.length > 0 && Object.prototype.hasOwnProperty.call(stops[0], 'zone_id');
  const zoned = corridor.filter((s) => (s.zone_id ?? '').trim() !== '');
  return {
    files: names,
    fareRows: rows,
    stopsZoneColumn: zoneColumn,
    corridorStops: corridor.length,
    corridorStopsWithZone: zoned.length,
    distinctCorridorZones: new Set(zoned.map((s) => s.zone_id.trim())).size,
  };
}
