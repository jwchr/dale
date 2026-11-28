import { describe, expect, it } from 'vitest';
import { createBusSession, reduceBusSession, type BusSession } from '../../src/domain/busLock';
import { lockableTrips } from '../../src/domain/schedule';
import { earlierBusTrip } from '../../src/domain/earlierBuses';
import { offerAlternatives } from '../../src/domain/alternatives';
import { wantedRide } from '../../src/domain/lockedAlerts';
import { toPastReports } from '../../src/domain/reportHistory';
import { backupDeadlines } from '../../src/domain/backupDeadlines';
import { saveLock, loadLock } from '../../src/domain/lockStore';
import { tripUpdate } from '../../src/domain/tripUpdate';
import type { Dataset, Departure } from '../../src/domain/types';

// Synthetic schedule and positions only. Acceptance evidence: pinned exact UTC instants below.
// Risks: false boarding claims (high), silent stop/trip changes (high), ambiguous dates (high).
// Mitigation: explicit phase gates, exact trip/date and stop sequence, unique epoch-ms matching.
const NOW = Date.parse('2026-11-04T05:05:00Z'); // 12:05 AM Eastern
function dataset(): Dataset {
  return {
    meta: { demo: false, source: 'Synthetic', feedVersion: 'test', builtAt: '2026-11-01', timezone: 'America/New_York' },
    routes: [{ id: 'R', shortName: '165', longName: 'Synthetic route' }],
    stops: ['A', 'B', 'C', 'D'].map(id => ({ id, name: id })),
    patterns: [{ id: 'P', routeId: 'R', directionId: 0, headsign: 'D', stopIds: ['A', 'B', 'C', 'D'] }],
    trips: [{ id: 'overnight', patternId: 'P', serviceId: 'daily', times: [86400, 86700, 87300, 87900] }],
    calendars: { daily: { start: '20261101', end: '20261130', days: [true, true, true, true, true, true, true], added: [], removed: [] } },
  };
}
function departure(ds = dataset()): Departure {
  return lockableTrips(ds, { stopId: 'B' }, NOW).find(d => d.serviceDate === '20261103')! as Departure;
}
function observe(s: BusSession, index: number, at = NOW, source: 'official' | 'demo' = 'official', id = s.departure.tripInstanceId): BusSession {
  return reduceBusSession(s, { type: 'observation', source, receivedAt: at, obs: {
    tripInstanceId: id, vehicleId: 'synthetic-vehicle', observedAt: at, lat: 40, lon: -74,
    stopCall: { status: 'stopped_at', stopIndex: index, stopId: s.departure.pattern.stopIds[index] ?? 'invalid' },
  } });
}

describe('anywhere and passed locks', () => {
  it('follows with no boarding stop through the final stop, without boarding claims or alerts', () => {
    const ds = dataset(), dep = { ...departure(ds), stopIndex: null };
    let s = createBusSession(dep, NOW);
    expect(s.phase).toBe('following');
    for (let i = 0; i < 4; i++) {
      const now = NOW + i * 60_000;
      s = observe(s, i, now);
      s = reduceBusSession(s, { type: 'tick', now });
      for (const type of ['start_waiting', 'arrived', 'boarded', 'left', 'no_bus', 'passed_without_stopping'] as const)
        s = reduceBusSession(s, { type, now });
      expect(s.phase).toBe('following');
      expect(s.departure.stopIndex).toBeNull();
      expect(s.lock.tripInstanceId).toBe('overnight@20261103');
      expect(s.lock.status).toBe('tracked');
      expect(s.reports).toEqual([]);
      expect(wantedRide(s, 3, 'en')).toBeUndefined();
      expect(tripUpdate(ds, s, 3, now).update.kind).toBe('planning');
    }
    expect(s.history).toHaveLength(4);
    expect(observe(s, 3, NOW + 5 * 60_000, 'official', 'overnight@20261104').lock.tripInstanceId).toBe(dep.tripInstanceId);
  });

  it('marks a bus already beyond the selected stop as passed, preserving that stop and comparisons', () => {
    const dep = departure();
    const s = observe(createBusSession(dep, NOW), 2);
    expect(s.phase).toBe('passed');
    expect(s.departure).toEqual(dep);
    expect(offerAlternatives(s, NOW)).toBe(true);
    expect(wantedRide(s, 3, 'en')).toBeUndefined();
    expect(reduceBusSession(s, { type: 'tick', now: NOW + 60_000 }).phase).toBe('passed');
    expect(reduceBusSession(s, { type: 'start_waiting', now: NOW }).phase).toBe('passed');
    expect(reduceBusSession(s, { type: 'arrived', now: NOW }).reports).toEqual([]);
    expect(reduceBusSession(s, { type: 'boarded', now: NOW }).phase).toBe('onboard'); // a late "I boarded" tap still counts
    expect(tripUpdate(dataset(), s, 3, NOW).update.kind).toBe('planning');
    // Like an unboarded viewing lock, a passed lock still records the bus's official arrival at the drop-off (bus evidence, not a boarding claim).
    const atD = observe(s, 3, NOW + 60_000);
    expect(atD.phase).toBe('passed');
    const arrival = { tripInstanceId: dep.tripInstanceId, stopId: 'D', stopIndex: 3, destination: 'D', route: '165',
      source: 'njt_stopped_at' as const, at: NOW + 60_000, recordedAt: NOW + 60_000, vehicleId: 'synthetic-vehicle' };
    expect(reduceBusSession(atD, { type: 'destination_arrival', arrival, now: NOW + 60_000 }).destinationArrival).toEqual(arrival);
    // Selecting a stop supplies its scheduled departure, so its clock is never borrowed from B.
    const later = lockableTrips(dataset(), { stopId: 'C' }, NOW).find(d => d.tripInstanceId === dep.tripInstanceId)! as Departure;
    const waiting = reduceBusSession(s, { type: 'choose_stop', departure: later, now: NOW });
    expect(waiting.phase).toBe('waiting');
    expect(waiting.departure.stopIndex).toBe(2);
    expect(waiting.departure.departs).toBe(Date.parse('2026-11-04T05:15:00Z'));
    expect(waiting.lock).toEqual(s.lock);
    expect(s.departure.stopIndex).toBe(1);
    const following = reduceBusSession(s, { type: 'follow', now: NOW });
    expect(following.phase).toBe('following');
    expect(following.departure.stopIndex).toBeNull();
    expect(following.lock).toEqual(s.lock);
  });

  it('changes waiting to passed only on accepted official, exact-trip, valid downstream stop evidence', () => {
    const waiting = reduceBusSession(createBusSession(departure(), NOW), { type: 'start_waiting', now: NOW });
    expect(observe(waiting, 0).phase).toBe('waiting'); // still coming
    expect(observe(waiting, 1).phase).toBe('waiting');
    expect(observe(waiting, 2, NOW, 'demo').phase).toBe('waiting');
    expect(observe(waiting, 99).phase).toBe('waiting');
    expect(observe(waiting, 2, NOW, 'official', 'overnight@20261104').phase).toBe('waiting');
    expect(observe(waiting, 2).phase).toBe('passed');
    const late = reduceBusSession(observe(waiting, 2), { type: 'boarded', now: NOW });
    expect(late.phase).toBe('onboard');
    expect(late.departure.stopIndex).toBe(1);
    const onboard = reduceBusSession(waiting, { type: 'boarded', now: NOW });
    expect(observe(onboard, 2).phase).toBe('onboard');
  });

  it('keeps passed comparisons and its saved boarding lock, and leaves reports at their original stops', () => {
    const ds = dataset(), dep = departure(ds);
    let waiting = reduceBusSession(createBusSession(dep, NOW), { type: 'start_waiting', now: NOW });
    waiting = reduceBusSession(waiting, { type: 'passed_without_stopping', now: NOW });
    const passed = observe(waiting, 2);
    expect(backupDeadlines(ds, passed, 3, NOW, 10)).toMatchObject({ show: true, reason: 'passed' });
    const values = new Map<string, string>();
    const store = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
    saveLock(store, ds, { dep, leg: { fromStopId: 'B', toStopId: 'D', routeIds: ['R'] }, session: passed }, NOW);
    expect(loadLock(store, ds, NOW)?.session.phase).toBe('passed');
    const later = lockableTrips(ds, { stopId: 'C' }, NOW).find(d => d.tripInstanceId === dep.tripInstanceId)! as Departure;
    const changed = reduceBusSession(passed, { type: 'choose_stop', departure: later, now: NOW });
    expect(toPastReports(ds, changed)).toMatchObject([{ stopId: 'B', slot: 1445, atMin: 0 }]);
    expect(toPastReports(ds, reduceBusSession(changed, { type: 'follow', now: NOW }))).toEqual(toPastReports(ds, changed));
  });

  it('rejects a different trip/date, earlier stop, terminal or no-pickup stop selection', () => {
    const dep = departure(), s = observe(createBusSession(dep, NOW), 2);
    for (const candidate of [dep, { ...dep, stopIndex: 0 }, { ...dep, stopIndex: 3 },
      { ...dep, stopIndex: 2, tripInstanceId: 'overnight@20261104', serviceDate: '20261104' },
      { ...dep, stopIndex: 2, pattern: { ...dep.pattern, noPickup: [2] } }])
      expect(reduceBusSession(s, { type: 'choose_stop', departure: candidate, now: NOW })).toBe(s);
  });
});

describe('schedule-only trip pool and Earlier links', () => {
  it('keys overnight service to yesterday and excludes inactive service dates', () => {
    const ds = dataset();
    ds.trips.push({ id: 'inactive', patternId: 'P', serviceId: 'off', times: [86400, 86700, 87300, 87900] });
    ds.calendars.off = { ...ds.calendars.daily!, days: [false, false, false, false, false, false, false] };
    const rows = lockableTrips(ds, { stopId: 'B', routeIds: ['R'], directionId: 0 }, NOW);
    expect(rows.map(d => d.tripInstanceId)).toEqual(['overnight@20261103', 'overnight@20261104']);
    expect(rows[0]).toMatchObject({ departs: NOW, serviceDate: '20261103', stopIndex: 1 });
    expect(lockableTrips(ds, {}, NOW).every(d => d.stopIndex === null)).toBe(true);
    expect(lockableTrips(ds, { routeIds: ['other'] }, NOW)).toEqual([]);
    expect(lockableTrips(ds, { directionId: 1 }, NOW)).toEqual([]);
    expect(lockableTrips(ds, { stopId: 'D' }, NOW)).toEqual([]);
  });

  it('links 12:05 AM to the previous service date and fails closed on missing, wrong or ambiguous matches', () => {
    const ds = dataset(), row = { route: '165', direction: 0 as const, stop: { scheduledAt: NOW, evidence: null }, portAuthority: null };
    expect(earlierBusTrip(ds, row, 'B', NOW)?.tripInstanceId).toBe('overnight@20261103');
    expect(earlierBusTrip(ds, { ...row, route: '164' }, 'B', NOW)).toBeUndefined();
    expect(earlierBusTrip(ds, { ...row, direction: 1 }, 'B', NOW)).toBeUndefined();
    expect(earlierBusTrip(ds, row, 'A', NOW)).toBeUndefined();
    expect(earlierBusTrip(ds, { ...row, stop: { scheduledAt: null, evidence: null } }, 'B', NOW)).toBeUndefined();
    expect(earlierBusTrip(ds, { ...row, stop: { scheduledAt: NOW + 1, evidence: null } }, 'B', NOW)).toBeUndefined();
    ds.trips.push({ ...ds.trips[0]!, id: 'duplicate' });
    expect(earlierBusTrip(ds, row, 'B', NOW)).toBeUndefined();
  });

  it('distinguishes both 1:05 AM instants on the fall-back Sunday using each service date', () => {
    const ds = dataset();
    ds.trips = [
      { id: 'first-hour', patternId: 'P', serviceId: 'daily', times: [90000, 90300, 90900, 91500] },
      { id: 'second-hour', patternId: 'P', serviceId: 'daily', times: [3600, 3900, 4500, 5100] },
    ];
    const first = Date.parse('2026-11-01T05:05:00Z'), second = Date.parse('2026-11-01T06:05:00Z');
    ds.calendars.daily!.start = '20261001';
    const row = (scheduledAt: number) => ({ route: '165', direction: 0 as const, stop: { scheduledAt, evidence: null }, portAuthority: null });
    expect(earlierBusTrip(ds, row(first), 'B', second)?.tripInstanceId).toBe('first-hour@20261031');
    expect(earlierBusTrip(ds, row(second), 'B', second)?.tripInstanceId).toBe('second-hour@20261101');
  });
  it('respects calendar exceptions, pickup restrictions, loops and service rollover without changing IDs', () => {
    const ds = dataset();
    ds.patterns[0]!.stopIds = ['A', 'B', 'B', 'D'];
    ds.patterns[0]!.noPickup = [1];
    ds.calendars.daily!.removed = ['20261104'];
    expect(lockableTrips(ds, { stopId: 'B' }, NOW)).toEqual([]);
    // Preserve departuresOn's first-occurrence policy for a repeated stop.
    ds.patterns[0]!.noPickup = [];
    const rows = lockableTrips(ds, { stopId: 'B' }, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tripInstanceId: 'overnight@20261103', stopIndex: 1 });
    ds.calendars.daily!.removed = ['20261103'];
    expect(lockableTrips(ds, { stopId: 'B' }, NOW).map(d => d.tripInstanceId)).toEqual(['overnight@20261104']);
    ds.calendars.daily!.days = [false, false, false, false, false, false, false];
    ds.calendars.daily!.added = ['20261104'];
    expect(lockableTrips(ds, {}, NOW).map(d => d.tripInstanceId)).toEqual(['overnight@20261104']);
  });

  it('uses GTFS noon-minus-12-hours in the spring gap instead of inventing a wall-clock match', () => {
    const ds = dataset(), now = Date.parse('2027-03-14T07:05:00Z');
    ds.calendars.daily = { ...ds.calendars.daily!, start: '20270301', end: '20270331' };
    ds.trips = [{ id: 'spring', patternId: 'P', serviceId: 'daily', times: [7200, 7500, 8100, 8700] }];
    const row = (scheduledAt: number) => ({ route: '165', direction: 0 as const, stop: { scheduledAt, evidence: null }, portAuthority: null });
    expect(earlierBusTrip(ds, row(Date.parse('2027-03-14T06:05:00Z')), 'B', now)?.tripInstanceId).toBe('spring@20270314');
    expect(earlierBusTrip(ds, row(now), 'B', now)).toBeUndefined();
  });

});
