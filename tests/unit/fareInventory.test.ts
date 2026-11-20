import { expect, it } from 'vitest';
// @ts-expect-error pure ESM workflow helper without declaration files
import { fareInventory } from '../../scripts/fare-inventory.mjs';

it('counts fare files and zoned corridor stops without exposing ids or prices', () => {
  const files = {
    'stops.txt': 'stop_id,stop_name,zone_id\nA,Alpha,Z1\nB,Beta,Z2\nC,Gamma,\nD,Delta,Z9\n',
    'fare_attributes.txt': 'fare_id,price,currency_type,payment_method,transfers\nF1,2.00,USD,1,0\n',
    'fare_rules.txt': 'fare_id,origin_id,destination_id\nF1,Z1,Z2\nF1,Z2,Z1\n',
  };
  const r = fareInventory(['gtfs/stops.txt', 'gtfs/fare_rules.txt', 'gtfs/fare_attributes.txt', 'gtfs/trips.txt'], files, ['A', 'B', 'C']);
  expect(r).toEqual({ files: ['fare_attributes.txt', 'fare_rules.txt', 'stops.txt', 'trips.txt'], fareRows: { 'fare_attributes.txt': 1, 'fare_rules.txt': 2 },
    stopsZoneColumn: true, corridorStops: 3, corridorStopsWithZone: 2, distinctCorridorZones: 2 });
  expect(JSON.stringify(r)).not.toMatch(/Z1|2\.00|Alpha/);
});

it('reports no fare data when the file has none', () => {
  const r = fareInventory(['stops.txt'], { 'stops.txt': 'stop_id,stop_name\nA,Alpha\n' }, ['A']);
  expect(r).toMatchObject({ fareRows: {}, stopsZoneColumn: false, corridorStopsWithZone: 0 });
});
