import { describe, expect, it } from 'vitest';
import { cityBoardingStops } from '../../src/domain/cityStops';
import { alightingStopFor, destinationsFrom, reaches } from '../../src/domain/direction';
import { departureEvidence, type DepartureBatch } from '../../src/domain/liveDepartures';
import { LIVE_MAX_AGE_MS, LIVE_SOURCE } from '../../src/domain/liveBus';
import { rescueOptions } from '../../src/domain/rescue';
import { zonedWallTime } from '../../src/domain/time';
import type { Dataset } from '../../src/domain/types';

// Synthetic trips and geography only; the terminal IDs reproduce the audited shape.
function terminalDataset(): Dataset {
  return {
    meta: { demo: true, source: 'synthetic', feedVersion: 'audit-a', builtAt: '2026-11-24T00:00:00Z', timezone: 'America/New_York' },
    routes: [{ id: 'R', shortName: 'Test', longName: 'Synthetic route' }],
    stops: [
      { id: 'A', name: 'Origin', lat: 40.9, lon: -74 },
      { id: 'C', name: 'Change', lat: 40.85, lon: -74 },
      { id: '26229-test', name: 'Synthetic gate', terminal: 'PABT', lat: 40.75, lon: -74 },
      { id: '31899', name: 'PORT AUTHORITY DROP OFF', terminal: 'PABT', lat: 40.7501, lon: -74 },
      { id: '31858', name: 'Synthetic final terminal', terminal: 'PABT', lat: 40.7502, lon: -74 },
    ],
    patterns: [{ id: 'P', routeId: 'R', directionId: 0, headsign: 'Terminal', stopIds: ['A', 'C', '31899', '31858'] }],
    trips: [{ id: 'direct', patternId: 'P', serviceId: 'S', times: [64800, 65400, 66600, 67200] }],
    calendars: { S: { days: [true, true, true, true, true, true, true], start: '20261101', end: '20261130', added: [], removed: [] } },
  };
}
const now = zonedWallTime(2026, 11, 24, 17, 30, 'America/New_York');

describe('audit A: terminal boardings and rescue', () => {
  it('excludes inbound terminal boardings', () => {
    const ds = terminalDataset();
    expect(cityBoardingStops(ds, []).map(s => s.id)).toEqual(['A', 'C']);
    ds.patterns.push({ id: 'out', routeId: 'R', directionId: 1, headsign: 'Origin', stopIds: ['26229-test', 'C', 'A'] });
    expect(cityBoardingStops(ds, ['R']).map(s => s.id)).toEqual(['A', 'C', '26229-test']);
    ds.patterns[1]!.noPickup = [0];
    expect(cityBoardingStops(ds, []).map(s => s.id)).toEqual(['A', 'C']);
  });

  it('rescues directly to any Port Authority gate', () => {
    const r = rescueOptions(terminalDataset(), 'A', '26229-test', now, 'R');
    expect(r.options.map(o => [o.dep.tripId, o.alightStopId, o.acrossFromHome])).toEqual([['direct', '31858', false]]);
    expect(r.options[0]!.arrives).toBe(zonedWallTime(2026, 11, 24, 18, 40, 'America/New_York'));
    expect(r.nearHome).toEqual([]);

    // Ordinary home/twin calls retain the first allowed arrival, unlike terminal calls.
    const ordinary = terminalDataset();
    ordinary.stops = ordinary.stops.map(({ terminal: _terminal, ...stop }) => stop);
    ordinary.stops.find(s => s.id === '31899')!.twin = '31858';
    expect(rescueOptions(ordinary, 'A', '31899', now).options[0]!.alightStopId).toBe('31899');
    ordinary.patterns[0]!.noDropOff = [2];
    expect(rescueOptions(ordinary, 'A', '31899', now).options[0]!.alightStopId).toBe('31858');
  });

  it('respects terminal drop-off restrictions', () => {
    const ds = terminalDataset();
    ds.patterns[0]!.noDropOff = [3];
    expect(rescueOptions(ds, 'A', '26229-test', now).options.map(o => o.alightStopId)).toEqual(['31899']);
    ds.patterns[0]!.noDropOff = [2, 3];
    const r = rescueOptions(ds, 'A', '26229-test', now);
    expect(r.options).toEqual([]);
    expect(r.nearHome).toEqual([]);
  });

  it('finds a transfer to any Port Authority gate', () => {
    const ds = terminalDataset();
    ds.patterns = [
      { id: 'first', routeId: 'R', directionId: 0, headsign: 'Change', stopIds: ['A', 'C'] },
      { id: 'second', routeId: 'R', directionId: 0, headsign: 'Terminal', stopIds: ['C', '31899', '31858'] },
    ];
    ds.trips = [
      { id: 'first', patternId: 'first', serviceId: 'S', times: [64800, 65400] },
      { id: 'second', patternId: 'second', serviceId: 'S', times: [65700, 66600, 67200] },
    ];
    const r = rescueOptions(ds, 'A', '26229-test', now);
    expect(r.options).toEqual([]);
    expect(r.transfers.map(x => [x.changeStopId, x.second.alightStopId, x.second.acrossFromHome])).toEqual([['C', '31858', false]]);
    expect(r.transfers[0]!.arrives).toBe(zonedWallTime(2026, 11, 24, 18, 40, 'America/New_York'));
    ds.patterns[1]!.noDropOff = [2];
    expect(rescueOptions(ds, 'A', '26229-test', now).transfers[0]!.second.alightStopId).toBe('31899');
    ds.patterns[1]!.noDropOff = [1, 2];
    expect(rescueOptions(ds, 'A', '26229-test', now).transfers).toEqual([]);
  });
});

describe('audit A: arrival-only boarding evidence', () => {
  it('expires arrival-only passed evidence', () => {
    const item = {
      query: { tripId: 'synthetic', serviceDate: '20261124', stopIndex: 0, toStopIndex: 1 },
      boardingArrival: { stopIndex: 0, kind: 'arrival' as const, observedAt: now - 1000, at: now - 1 },
    };
    const batch: DepartureBatch = {
      v: 1, source: LIVE_SOURCE, feedVersion: 'synthetic', receivedAt: now,
      vehicles: { state: 'unavailable' }, updates: { state: 'ok', timestamp: now }, items: [item],
    };
    expect(departureEvidence(batch, item, now).kind).toBe('passed');
    item.boardingArrival.observedAt = now - LIVE_MAX_AGE_MS - 1;
    expect(departureEvidence(batch, item, now).kind).toBe('no-prediction');
    item.boardingArrival.observedAt = now;
    item.boardingArrival.at = now;
    expect(departureEvidence(batch, item, now).kind).toBe('live');
  });
});

describe('audit A: repeated downstream stop', () => {
  it('finds downstream repeated destinations', () => {
    const ds = terminalDataset();
    ds.stops = ['S1', 'S2', 'S3', 'S4'].map(id => ({ id, name: id }));
    ds.patterns[0]!.stopIds = ['S1', 'S2', 'S3', 'S2', 'S4'];
    expect(reaches(ds, 'S3', 'S2')).toBe(true);
    expect(destinationsFrom(ds, 'S3').map(s => s.id)).toEqual(['S2', 'S4']);
    expect(alightingStopFor(ds, 'S3', 'S2')?.id).toBe('S2');
    ds.patterns[0]!.noDropOff = [3];
    expect(reaches(ds, 'S3', 'S2')).toBe(false);
    expect(destinationsFrom(ds, 'S3').map(s => s.id)).toEqual(['S4']);
    expect(alightingStopFor(ds, 'S3', 'S2')).toBeUndefined();
  });
});

describe('audit A follow-up (Gemini Flash, #280)', () => {
  it('lets a fresh arrival report show passed when the departure report is stale', () => {
    const item = {
      query: { tripId: 'synthetic', serviceDate: '20261124', stopIndex: 0, toStopIndex: 1 },
      departure: { stopIndex: 0, kind: 'departure' as const, observedAt: now - LIVE_MAX_AGE_MS - 1, at: now - 60_000 },
      boardingArrival: { stopIndex: 0, kind: 'arrival' as const, observedAt: now - 1000, at: now - 1 },
    };
    const batch: DepartureBatch = {
      v: 1, source: LIVE_SOURCE, feedVersion: 'synthetic', receivedAt: now,
      vehicles: { state: 'unavailable' }, updates: { state: 'ok', timestamp: now }, items: [item],
    };
    expect(departureEvidence(batch, item, now).kind).toBe('passed');
    item.boardingArrival.observedAt = now - LIVE_MAX_AGE_MS - 1;
    expect(departureEvidence(batch, item, now).kind).toBe('no-prediction');
  });
});
