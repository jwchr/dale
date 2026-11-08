import { liveDataset } from './liveBus';
import { STOP_CITY_SOURCE } from '../../src/domain/stopInfo';

// Synthetic geography and return pattern, isolated from production schedules.
export function cityDataset() {
  const ds = structuredClone(liveDataset);
  ds.meta.stopCities = { state: 'verified', source: 'NJ Transit GIS Department', url: STOP_CITY_SOURCE, retrievedAt: '2026-11-04T10:00:00Z' };
  Object.assign(ds.stops.find(s => s.id === '1')!, { city: 'Fort Lee', name: 'Bridge Plaza', lat: 40.85, lon: -73.97 });
  Object.assign(ds.stops.find(s => s.id === '2')!, { city: 'Hackensack', name: 'State Street at Lawrence Street', twin: '5' });
  ds.stops.push({ id: 'unknown', name: 'Unclassified source stop' });
  ds.stops.push({ id: '5', code: '30005', name: 'State Street opposite Lawrence Street', city: 'Hackensack', twin: '2', lat: 40.87, lon: -74.0401 });
  const outward = ds.patterns.find(p => p.stopIds.includes('2'))!;
  ds.patterns.push({ ...outward, id: 'return', directionId: 1, headsign: 'HACKENSACK', stopIds: ['3', '5', '1'] });
  const trip = ds.trips.find(t => t.patternId === outward.id)!;
  ds.trips.push({ ...trip, id: 'return-trip', patternId: 'return', times: [30000, 32400, 33000], arrivals: [30000, 32400, 33000] });
  return ds;
}
