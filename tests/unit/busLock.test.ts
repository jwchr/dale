import { describe, expect, it } from 'vitest';
import { activeDownstreamReports, createBusSession, getScheduleProjection, MAX_POSITION_HISTORY, reduceBusSession, REPORT_TTL_MS, type BusSession, type RiderReport } from '../../src/domain/busLock';
import type { VehicleObservation } from '../../src/domain/lock';
import type { Departure } from '../../src/domain/types';

// Invented trip, times and coordinates; never a recorded NJ Transit or rider location.
const START = Date.UTC(2026, 10, 4, 12);
const MIN = 60_000;
const dep: Departure = {
  tripInstanceId: 'synthetic-trip@20261104', tripId: 'synthetic-trip', serviceDate: '20261104',
  route: { id: 'synthetic-route', shortName: 'Demo', longName: 'Synthetic test route' },
  pattern: { id: 'synthetic-pattern', routeId: 'synthetic-route', directionId: 0, headsign: 'Synthetic destination', stopIds: ['A', 'B', 'C', 'D'] },
  stopIndex: 1, departs: START + 10 * MIN, estimated: false, arrivesEnd: START + 30 * MIN,
};
const times = dep.pattern.stopIds.map((stopId, i) => ({ stopId, at: START + i * 10 * MIN }));
const make = (now = START): BusSession => createBusSession(dep, now, 'test-session');
const waiting = (now = START): BusSession => reduceBusSession(make(now), { type: 'start_waiting', now });
const obs = (observedAt = START, vehicleId = 'synthetic-bus-A', id = dep.tripInstanceId): VehicleObservation => ({
  tripInstanceId: id, vehicleId, observedAt, lat: 40, lon: -74,
});
const position = (s: BusSession, o: VehicleObservation, receivedAt = o.observedAt): BusSession =>
  reduceBusSession(s, { type: 'observation', obs: o, source: 'demo', receivedAt });
const report = (overrides: Partial<RiderReport> = {}): RiderReport => ({
  sessionId: 'reporter-A', tripInstanceId: dep.tripInstanceId, stopId: 'B', stopIndex: 1,
  kind: 'no_bus', reportedAt: dep.departs, waitingSince: START, ...overrides,
});

describe('Bus Lock waiting evidence', () => {
  it('keeps the exact scheduled instance and boarding stop, distinct from the next day', () => {
    const s = make();
    expect(s.departure.tripInstanceId).toBe(dep.tripInstanceId);
    expect(s.departure.pattern.stopIds[s.departure.stopIndex!]).toBe('B');
    expect(position(s, obs(START, 'synthetic-bus-A', 'synthetic-trip@20261105'))).toBe(s);
    expect(s.history).toEqual([]);
  });

  it('requires an explicit waiting action and due time before a no-bus observation', () => {
    expect(reduceBusSession(make(), { type: 'no_bus', now: dep.departs }).reports).toEqual([]);
    expect(reduceBusSession(waiting(), { type: 'no_bus', now: dep.departs - 1 }).reports).toEqual([]);
    const s = reduceBusSession(waiting(), { type: 'no_bus', now: dep.departs });
    expect(s.reports[0]).toMatchObject({ kind: 'no_bus', reportedAt: dep.departs, waitingSince: START, stopId: 'B', tripInstanceId: dep.tripInstanceId });
    expect(s.lock.status).toBe('scheduled_only');
  });

  it('records a late check-in only from the actual start of that rider’s wait', () => {
    const started = dep.departs + 5 * MIN;
    const s = reduceBusSession(waiting(started), { type: 'no_bus', now: started + MIN });
    expect(s.reports[0]?.waitingSince).toBe(started);
    expect(s.reports[0]?.reportedAt).toBe(started + MIN);
  });

  it('does not manufacture observations from elapsed time or duplicate votes from repeated taps', () => {
    let s = reduceBusSession(waiting(), { type: 'tick', now: dep.departs + MIN });
    expect(s.reports).toEqual([]);
    s = reduceBusSession(s, { type: 'no_bus', now: dep.departs + MIN });
    s = reduceBusSession(s, { type: 'no_bus', now: dep.departs + 2 * MIN });
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0]?.reportedAt).toBe(dep.departs + 2 * MIN);
    s = reduceBusSession(s, { type: 'tick', now: dep.departs + 4 * MIN });
    expect(s.reports[0]?.reportedAt).toBe(dep.departs + 2 * MIN);
    expect(s.lastActionAt).toBe(dep.departs + 2 * MIN);
  });

  it('arrival ends waiting but neither boards nor starts any location contribution', () => {
    let s = reduceBusSession(waiting(), { type: 'no_bus', now: dep.departs });
    s = reduceBusSession(s, { type: 'arrived', now: dep.departs + MIN });
    expect(s.phase).toBe('arrived');
    expect(s.reports.map((r) => r.kind)).toEqual(['no_bus', 'arrived']);
    expect(s.history).toEqual([]);
    expect(reduceBusSession(s, { type: 'no_bus', now: dep.departs + 2 * MIN })).toBe(s);
    expect(reduceBusSession(s, { type: 'boarded', now: dep.departs + 2 * MIN }).phase).toBe('onboard');
  });

  it('leaving ends this observation session without recording an arrival or cancellation', () => {
    const s = reduceBusSession(waiting(), { type: 'left', now: dep.departs });
    expect(s.phase).toBe('left');
    expect(s.lock.status).toBe('ended');
    expect(s.reports.map((r) => r.kind)).toEqual(['left']);
    expect(position(s, obs(dep.departs + MIN))).toBe(s);
    expect(reduceBusSession(s, { type: 'boarded', now: dep.departs + MIN })).toBe(s);
  });

  it('a pass-up remains distinct from arrival and the rider remains waiting', () => {
    const s = reduceBusSession(waiting(), { type: 'passed_without_stopping', now: dep.departs });
    expect(s.phase).toBe('waiting');
    expect(s.reports[0]?.kind).toBe('passed_without_stopping');
    expect(s.lock.status).toBe('scheduled_only');
    expect(reduceBusSession(s, { type: 'no_bus', now: dep.departs + MIN })).toBe(s);
  });

  it('only a matching official cancellation changes the service status', () => {
    let s = reduceBusSession(waiting(), { type: 'no_bus', now: dep.departs });
    s = reduceBusSession(s, { type: 'official_cancellation', tripInstanceId: 'other@20261104', now: dep.departs });
    expect(s.lock.status).toBe('scheduled_only');
    s = reduceBusSession(s, { type: 'official_cancellation', tripInstanceId: dep.tripInstanceId, now: dep.departs });
    expect(s.lock.status).toBe('cancelled');
    expect(getScheduleProjection(s, times, dep.departs).reason).toBe('cancelled');
  });
});

describe('Bus Lock vehicle evidence', () => {
  it('ages the actual observation even when the fetch just completed', () => {
    const s = position(make(), obs(START), START + 11 * MIN);
    expect(s.lock.status).toBe('vanished');
    expect(s.lastReceivedAt).toBe(START + 11 * MIN);
    expect(s.history).toEqual([{ ...obs(START), source: 'demo', receivedAt: START + 11 * MIN }]);
  });

  it('ignores old/duplicate positions without refreshing their observed time or adding history', () => {
    let s = position(make(), obs(START + MIN));
    s = position(s, obs(START), START + 2 * MIN);
    s = position(s, obs(START + MIN), START + 5 * MIN);
    expect(s.history).toHaveLength(1);
    expect(s.lock.last?.observedAt).toBe(START + MIN);
    expect(s.lock.status).toBe('stale');
  });

  it('rejects invalid coordinates, invalid timestamps and future signals', () => {
    for (const o of [
      { ...obs(), lat: Number.NaN }, { ...obs(), lon: 181 }, { ...obs(), lat: -91 },
      { ...obs(), observedAt: Number.POSITIVE_INFINITY }, { ...obs(), observedAt: -1 }, { ...obs(), observedAt: 0 },
      obs(START + 1), { ...obs(), vehicleId: '' },
    ]) {
      const s = make();
      expect(position(s, o, START)).toBe(s);
    }
  });

  it('holds a different vehicle for confirmation without inserting it into history', () => {
    let s = position(make(), obs(START));
    s = position(s, obs(START + MIN, 'synthetic-bus-B'));
    expect(s.lock.status).toBe('needs_confirmation');
    expect(s.lock.vehicleId).toBe('synthetic-bus-A');
    expect(s.history).toHaveLength(1);
    expect(s.pendingPosition?.source).toBe('demo');
    s = reduceBusSession(s, { type: 'confirm_pending', now: START + 4 * MIN });
    expect(s.lock.vehicleId).toBe('synthetic-bus-B');
    expect(s.lock.status).toBe('stale');
    expect(s.departure.tripInstanceId).toBe(dep.tripInstanceId);
    expect(s.history.map((p) => p.vehicleId)).toEqual(['synthetic-bus-A', 'synthetic-bus-B']);
  });

  it('does not let an old reassignment displace newer evidence', () => {
    const s = position(make(), obs(START + 2 * MIN));
    expect(position(s, obs(START + MIN, 'synthetic-bus-B'), START + 3 * MIN)).toBe(s);
    let pending = position(s, obs(START + 4 * MIN, 'synthetic-bus-B'));
    const same = pending;
    pending = position(pending, obs(START + 3 * MIN, 'synthetic-bus-B'), START + 5 * MIN);
    expect(pending).toBe(same);
    expect(position(pending, obs(START + 3 * MIN, 'synthetic-bus-C'), START + 5 * MIN)).toBe(same);
  });

  it('never moves the selected departure onto the same vehicle’s next trip', () => {
    let s = position(make(), obs(START));
    s = position(s, obs(START + MIN, 'synthetic-bus-A', 'next-trip@20261104'));
    expect(s.lock.status).toBe('needs_confirmation');
    expect(reduceBusSession(s, { type: 'confirm_pending', now: START + 2 * MIN })).toBe(s);
    s = reduceBusSession(s, { type: 'reject_pending', now: START + 4 * MIN });
    expect(s.lock.tripInstanceId).toBe(dep.tripInstanceId);
    expect(s.departure.tripInstanceId).toBe(dep.tripInstanceId);
    expect(s.lock.status).toBe('stale');
  });

  it('keeps a bounded, timestamped history of actual points and preserves gaps', () => {
    let s = make();
    for (let i = 0; i < MAX_POSITION_HISTORY + 2; i++) s = position(s, obs(START + i * MIN));
    const before = s.history;
    s = reduceBusSession(s, { type: 'tick', now: START + 200 * MIN });
    expect(s.history).toBe(before);
    expect(s.history).toHaveLength(MAX_POSITION_HISTORY);
    expect(s.history[0]?.observedAt).toBe(START + 2 * MIN);
    expect(s.history.at(-1)?.observedAt).toBe(START + (MAX_POSITION_HISTORY + 1) * MIN);
  });
});

describe('schedule projection is never vehicle observation', () => {
  it('returns explicitly estimated timetable progress, without manufacturing coordinates', () => {
    const s = make();
    expect(getScheduleProjection(s, times, START - MIN).kind).toBe('before_start');
    expect(getScheduleProjection(s, times, START + 5 * MIN)).toEqual({
      estimated: true, basis: 'schedule', computedAt: START + 5 * MIN,
      kind: 'between', fromIndex: 0, toIndex: 1, fraction: 0.5,
    });
    expect(getScheduleProjection(s, times, dep.arrivesEnd).kind).toBe('after_end');
    expect(s.history).toEqual([]);
  });

  it('stops projecting past a rider who is still waiting after the scheduled time', () => {
    const s = waiting();
    expect(getScheduleProjection(s, times, dep.departs)).toMatchObject({ kind: 'overdue_unknown', estimated: true });
    const noBus = reduceBusSession(s, { type: 'no_bus', now: dep.departs + MIN });
    expect(getScheduleProjection(noBus, times, dep.arrivesEnd + MIN).kind).toBe('overdue_unknown');
    expect(noBus.lock.status).not.toBe('cancelled');
  });

  it('rejects a mismatched or nonmonotonic schedule, and handles equal-time stops', () => {
    const s = make();
    expect(getScheduleProjection(s, [{ stopId: 'wrong', at: START }, ...times.slice(1)], START).reason).toBe('invalid_schedule');
    expect(getScheduleProjection(s, [times[0]!, { stopId: 'B', at: START - 1 }, ...times.slice(2)], START).reason).toBe('invalid_schedule');
    const equal = [times[0]!, { stopId: 'B', at: START }, ...times.slice(2)];
    expect(getScheduleProjection(s, equal, START)).toMatchObject({ kind: 'between', fromIndex: 1, toIndex: 2, fraction: 0 });
  });
});

describe('downstream warning selection', () => {
  it('requires the same exact trip/day and upstream stop, with finite fresh evidence', () => {
    const now = dep.departs + MIN;
    const valid = report();
    const reports = [valid, report({ tripInstanceId: 'synthetic-trip@20261105' }), report({ stopIndex: 2, stopId: 'C' }),
      report({ stopIndex: 3, stopId: 'D' }), report({ reportedAt: now + 1 }), report({ reportedAt: now - REPORT_TTL_MS }),
      report({ waitingSince: undefined }), report({ waitingSince: now + MIN })];
    expect(activeDownstreamReports(reports, dep.tripInstanceId, 2, now)).toEqual([valid]);
    expect(activeDownstreamReports([valid], dep.tripInstanceId, -1, now)).toEqual([]);
  });

  it('counts a reporting session once, without treating repeated taps as independent riders', () => {
    const first = report();
    const newer = report({ reportedAt: dep.departs + MIN });
    const other = report({ sessionId: 'reporter-B', reportedAt: dep.departs + 2 * MIN });
    expect(activeDownstreamReports([first, newer, other], dep.tripInstanceId, 3, dep.departs + 3 * MIN)).toEqual([other, newer]);
    const sameSessionElsewhere = report({ stopId: 'A', stopIndex: 0, reportedAt: dep.departs + 2 * MIN });
    expect(activeDownstreamReports([first, newer, sameSessionElsewhere], dep.tripInstanceId, 3, dep.departs + 3 * MIN)).toEqual([sameSessionElsewhere]);
  });

  it('arrival or boarding supersedes older no-bus reports at that stop, without erasing a pass-up', () => {
    const missing = report();
    const arrived = report({ sessionId: 'reporter-B', kind: 'arrived', reportedAt: dep.departs + MIN });
    const passed = report({ sessionId: 'reporter-C', kind: 'passed_without_stopping', reportedAt: dep.departs });
    const now = dep.departs + 2 * MIN;
    expect(activeDownstreamReports([missing, arrived, passed], dep.tripInstanceId, 3, now)).toEqual([passed]);
    expect(activeDownstreamReports([missing, { ...arrived, kind: 'boarded' }], dep.tripInstanceId, 3, now)).toEqual([]);
    // A later no-bus report is a new conflict, not silently overwritten by an earlier sighting.
    const later = report({ reportedAt: dep.departs + 2 * MIN });
    expect(activeDownstreamReports([later, arrived], dep.tripInstanceId, 3, now)).toEqual([later]);
    const contradictory = report({ sessionId: passed.sessionId, reportedAt: now });
    expect(activeDownstreamReports([passed, contradictory], dep.tripInstanceId, 3, now)).toEqual([passed]);
    expect(activeDownstreamReports([missing, passed], dep.tripInstanceId, 3, now)).toEqual([passed]);
  });

  it('leaving is not an arrival, and the last dated observation expires normally', () => {
    const missing = report();
    const left = report({ kind: 'left', reportedAt: dep.departs + MIN });
    expect(activeDownstreamReports([missing, left], dep.tripInstanceId, 3, dep.departs + 2 * MIN)).toEqual([missing]);
    expect(activeDownstreamReports([missing, left], dep.tripInstanceId, 3, dep.departs + REPORT_TTL_MS)).toEqual([]);
  });
});

describe('capacity observations (issue #33)', () => {
  const capacity = (s: BusSession, level: 'seats' | 'standing' | 'full', now: number) => reduceBusSession(s, { type: 'capacity', level, now });
  const arrived = () => reduceBusSession(waiting(), { type: 'arrived', now: dep.departs });

  it('come only from a rider who saw the bus: arrived, on board, or passed by', () => {
    expect(capacity(waiting(), 'full', dep.departs).reports).toHaveLength(0);
    const one = capacity(arrived(), 'standing', dep.departs + MIN).reports.at(-1);
    expect(one).toMatchObject({ kind: 'capacity', capacity: 'standing', reportedAt: dep.departs + MIN });
    expect(one).not.toHaveProperty('waitingSince'); // no wait-start time on a crowding answer
    const onboard = reduceBusSession(arrived(), { type: 'boarded', now: dep.departs + MIN });
    expect(capacity(onboard, 'seats', dep.departs + 2 * MIN).reports.at(-1)).toMatchObject({ kind: 'capacity', capacity: 'seats' });
    const passed = reduceBusSession(waiting(), { type: 'passed_without_stopping', now: dep.departs });
    expect(capacity(passed, 'full', dep.departs + MIN).reports.at(-1)).toMatchObject({ kind: 'capacity', capacity: 'full' });
  });

  it('keep one answer per session: a new tap replaces the old one', () => {
    const s = capacity(capacity(arrived(), 'seats', dep.departs + MIN), 'full', dep.departs + 2 * MIN);
    expect(s.reports.filter((r) => r.kind === 'capacity')).toEqual([expect.objectContaining({ capacity: 'full', reportedAt: dep.departs + 2 * MIN })]);
  });

  it('are ignored after the session ends, for unknown levels, and for earlier times', () => {
    const left = reduceBusSession(arrived(), { type: 'left', now: dep.departs + MIN });
    expect(capacity(left, 'full', dep.departs + 2 * MIN)).toBe(left);
    const a = arrived();
    expect(reduceBusSession(a, { type: 'capacity', level: 'empty' as never, now: dep.departs + MIN })).toBe(a);
    expect(capacity(a, 'full', dep.departs - MIN)).toBe(a);
  });

  it('never count as a no-bus or pass-up warning downstream, and never supersede one', () => {
    const noBus = report({ sessionId: 'reporter-A', kind: 'no_bus', reportedAt: dep.departs + MIN, waitingSince: START });
    const crowd = report({ sessionId: 'reporter-B', kind: 'capacity', capacity: 'full', reportedAt: dep.departs + 2 * MIN });
    expect(activeDownstreamReports([noBus, crowd], dep.tripInstanceId, 3, dep.departs + 3 * MIN)).toEqual([noBus]);
    expect(activeDownstreamReports([crowd], dep.tripInstanceId, 3, dep.departs + 3 * MIN)).toEqual([]);
  });
});
