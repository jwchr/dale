import { describe, expect, it } from 'vitest';
import { addToCell, alreadyCounted, arrivalEvents, bucketIndex, dayTypeOf, deriveArrivals, parseConfidenceQuery, summarize, BUCKET_COUNT, MIN_CONFIDENCE_SAMPLES,
  type ArrivalEvent, type ConfidenceCell, type ConfidenceKey } from '../../src/domain/arrivalConfidence';
import { MIN_HISTORY } from '../../src/domain/etaBacktest';
import type { VehicleObservation } from '../../src/domain/lock';
import type { ServiceCalendar } from '../../src/domain/types';
import { liveDataset as ds } from '../helpers/liveBus';

// Synthetic only. T1 (route 165) is scheduled at stop "1" at 7:00 AM and stop "3" at 7:40 AM on weekdays.
const at = (date: string, hhmmss: string) => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${hhmmss}-05:00`);
const stopped = (trip: string, observedAt: number, stopIndex: number, stopId: string, patch: Partial<VehicleObservation> = {}): VehicleObservation =>
  ({ tripInstanceId: trip, vehicleId: 'SECRET-BUS-4417', observedAt, lat: 40.912345, lon: -74.054321, stopCall: { status: 'stopped_at', stopId, stopIndex }, ...patch });
const moving = (trip: string, observedAt: number): VehicleObservation => ({ tripInstanceId: trip, vehicleId: 'SECRET-BUS-4417', observedAt, lat: 40.9, lon: -74.05 });
const key: ConfidenceKey = { route: '165', direction: 0, stopId: '1', schedMinute: 7 * 60, dayType: 'weekday' };
const event = (serviceDate: string, delaySeconds: number, arrivedAt = at(serviceDate, '07:00:00') + delaySeconds * 1000): ArrivalEvent =>
  ({ key, serviceDate, arrivedAt, delaySeconds });
const fill = (events: ArrivalEvent[]) => events.reduce<ConfidenceCell | undefined>((cell, e) => addToCell(cell, e), undefined)!;
const WEEKDAYS = ['20261102', '20261103', '20261104', '20261105', '20261106', '20261109', '20261110'];

describe('arrival confidence buckets', () => {
  it('puts early, on-time, late and overflow delays in the right one-minute bucket', () => {
    expect(BUCKET_COUNT).toBe(32);
    expect([-3600, -601, -600, -61, -60, -1, 0, 59, 60, 299, 300, 1199, 1200, 10_800].map(bucketIndex))
      .toEqual([0, 0, 1, 9, 10, 10, 11, 11, 12, 15, 16, 30, 31, 31]);
  });
  it('summarizes one- and five-minute shares, records and uncertainty from the same counts', () => {
    const cell = fill([event(WEEKDAYS[0]!, -700), event(WEEKDAYS[1]!, -30), event(WEEKDAYS[2]!, 0), event(WEEKDAYS[3]!, 240),
      { ...event(WEEKDAYS[4]!, 310), windowSeconds: 30 }, { ...event(WEEKDAYS[5]!, 1260), windowSeconds: 50 }]);
    const answer = summarize(cell, key, 'synthetic');
    expect(answer.state).toBe('ready');
    if (answer.state !== 'ready') return;
    expect(answer.samples).toBe(6);
    expect(answer.oneMinute).toHaveLength(32);
    expect(answer.oneMinute[0]).toEqual({ fromMinute: null, toMinute: -10, count: 1 });
    expect(answer.oneMinute.find((b) => b.fromMinute === -1)).toEqual({ fromMinute: -1, toMinute: 0, count: 1 });
    expect(answer.oneMinute[31]).toEqual({ fromMinute: 20, toMinute: null, count: 1 });
    expect(answer.fiveMinute.map((b) => [b.fromMinute, b.count])).toEqual([[null, 1], [-10, 0], [-5, 1], [0, 2], [5, 1], [10, 0], [15, 0], [20, 1]]);
    expect(answer.oneMinute.reduce((a, b) => a + b.count, 0)).toBe(6);
    expect(answer.fiveMinute.reduce((a, b) => a + b.count, 0)).toBe(6);
    expect(answer.worst).toMatchObject({ minutes: 21, delaySeconds: 1260, serviceDate: '2026-11-09' });
    expect(answer.best).toMatchObject({ minutes: 0, delaySeconds: 0, serviceDate: '2026-11-04' });
    expect(answer.earliest).toMatchObject({ minutes: -11, delaySeconds: -700, serviceDate: '2026-11-02' });
    expect(answer.worst.arrivedAt).toBe(at('20261109', '07:21:00'));
    expect(answer).toMatchObject({ firstServiceDate: '2026-11-02', lastServiceDate: '2026-11-09', query: { scheduled: '07:00', dayType: 'weekday' },
      uncertainty: { boundedSamples: 2, meanWindowSeconds: 40 }, measurement: 'first-official-stopped-at-sample' });
  });
  it('answers insufficient below the backtest minimum, with no histogram or record', () => {
    expect(MIN_CONFIDENCE_SAMPLES).toBe(MIN_HISTORY);
    expect(MIN_CONFIDENCE_SAMPLES).toBe(5);
    expect(summarize(undefined, key, 'synthetic')).toEqual({ v: 1, state: 'insufficient', samples: 0, minimumSamples: 5,
      query: { route: '165', direction: 0, stopId: '1', scheduled: '07:00', dayType: 'weekday' } });
    const four = summarize(fill(WEEKDAYS.slice(0, 4).map((d) => event(d, 60))), key, 'synthetic');
    expect(four).toMatchObject({ state: 'insufficient', samples: 4 });
    expect(four).not.toHaveProperty('worst');
    expect(summarize(fill(WEEKDAYS.slice(0, 5).map((d) => event(d, 60))), key, 'synthetic').state).toBe('ready');
  });
  it('counts a service date once and gives the same records in any order', () => {
    const events = [event(WEEKDAYS[0]!, 120), event(WEEKDAYS[1]!, 120), event(WEEKDAYS[2]!, -120), event(WEEKDAYS[3]!, 120), event(WEEKDAYS[4]!, 900)];
    const cell = fill(events);
    expect(addToCell(cell, event(WEEKDAYS[0]!, 1500))).toBe(cell);
    expect(alreadyCounted(cell, WEEKDAYS[0]!)).toBe(true);
    expect(alreadyCounted(cell, WEEKDAYS[6]!)).toBe(false);
    expect(fill([...events].reverse())).toEqual(cell);
    expect(cell.b[1]).toBe(WEEKDAYS[0]);
  });
});

describe('scheduled match and day type', () => {
  it('uses the schedule calendar: weekday flags, holiday-only dates, a dates-only majority, else the date', () => {
    const cal = (days: boolean[], added: string[] = []): ServiceCalendar => ({ days: days as ServiceCalendar['days'], start: '20261101', end: '20270430', added, removed: [] });
    expect(dayTypeOf(ds.calendars.WK!, '20261104')).toBe('weekday');
    expect(dayTypeOf(ds.calendars.HOL!, '20261126')).toBe('sunday');
    expect(dayTypeOf(cal([false, false, false, false, false, true, false]), '20261107')).toBe('saturday');
    expect(dayTypeOf(cal([false, false, false, false, false, false, false], ['20261102', '20261103', '20261104', '20261108']), '20261108')).toBe('weekday');
    expect(dayTypeOf(cal([false, false, false, false, false, false, false], ['20261101', '20261108', '20261115', '20261126']), '20261126')).toBe('sunday');
    expect(dayTypeOf(cal([true, true, true, true, true, true, true]), '20261107')).toBe('saturday');
  });
  it('matches arrivals to NJ Transit scheduled times only, and counts every exclusion', () => {
    const base = { stopIndex: 0, stopId: '1' };
    const copy = structuredClone(ds);
    copy.routes.push({ id: '99', shortName: '999', longName: 'Elsewhere' });
    copy.patterns.push({ id: 'P9', routeId: '99', directionId: 0, headsign: 'x', stopIds: ['1'] });
    copy.trips.push({ id: 'T9', patternId: 'P9', serviceId: 'WK', times: [25200] });
    const { events, skipped } = arrivalEvents(copy, [
      { tripInstanceId: 'T1@20261104', observedAt: at('20261104', '07:02:30'), ...base, notBefore: at('20261104', '07:02:00') },
      { tripInstanceId: 'T2@20261104', observedAt: Date.parse('2026-11-05T05:15:00Z'), ...base },
      { tripInstanceId: 'T1@20261104', observedAt: at('20261104', '07:20:00'), stopIndex: 1, stopId: '2' },
      { tripInstanceId: 'T9@20261104', observedAt: at('20261104', '07:00:00'), ...base },
      { tripInstanceId: 'T1@20261104', observedAt: at('20261104', '07:00:00'), stopIndex: 0, stopId: '3' },
      { tripInstanceId: 'T1@20261126', observedAt: at('20261126', '07:00:00'), ...base },
      { tripInstanceId: 'T1@20261104', observedAt: at('20261104', '11:00:00'), stopIndex: 2, stopId: '3' },
      { tripInstanceId: 'NOPE@20261104', observedAt: 1, ...base },
    ]);
    expect(events).toEqual([
      { key, serviceDate: '20261104', arrivedAt: at('20261104', '07:02:30'), delaySeconds: 150, windowSeconds: 30 },
      { key: { ...key, schedMinute: 24 * 60 + 10 }, serviceDate: '20261104', arrivedAt: Date.parse('2026-11-05T05:15:00Z'), delaySeconds: 300 },
    ]);
    expect(skipped).toEqual({ 'estimated-time': 1, 'outside-corridor': 1, 'stop-mismatch': 1, 'inactive-date': 1, 'implausible-delay': 1, 'unknown-trip': 1 });
  });
  it('reuses the backtest arrival rule: the first stopped sample counts, and a bus still stopped across folds counts once', () => {
    const trip = 'T1@20261104';
    const first = deriveArrivals(ds, [moving(trip, at('20261104', '06:58:00')), stopped(trip, at('20261104', '06:59:30'), 0, '1'), stopped(trip, at('20261104', '07:00:00'), 0, '1')]);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ delaySeconds: -30 });
    expect(first.events[0]).not.toHaveProperty('windowSeconds');
    // Next fold: still stopped at stop 1 (not new), then first seen stopped at stop 3.
    const second = deriveArrivals(ds, [stopped(trip, at('20261104', '07:01:00'), 0, '1'), moving(trip, at('20261104', '07:30:00')), stopped(trip, at('20261104', '07:41:00'), 2, '3')], first.continuity);
    expect(second.events).toEqual([{ key: { ...key, stopId: '3', schedMinute: 460 }, serviceDate: '20261104', arrivedAt: at('20261104', '07:41:00'), delaySeconds: 60, windowSeconds: 2400 }]);
    // A position without a stop call never becomes an arrival.
    expect(deriveArrivals(ds, [moving(trip, at('20261104', '07:00:00'))]).events).toEqual([]);
  });
});

describe('arrival confidence query and privacy', () => {
  const q = (s: string) => parseConfidenceQuery(new URLSearchParams(s), ds);
  it('accepts exactly route, stop, dir, sched and day', () => {
    expect(q('route=165&stop=1&dir=0&sched=07:00&day=weekday')).toEqual(key);
    expect(q('route=165T&stop=3&dir=0&sched=24:10&day=sunday')).toEqual({ route: '165T', direction: 0, stopId: '3', schedMinute: 1450, dayType: 'sunday' });
    for (const bad of ['', 'route=165&stop=1&dir=0&sched=07:00', 'route=165&stop=1&dir=0&sched=07:00&day=weekday&x=1',
      'route=165&route=165&stop=1&dir=0&sched=07:00&day=weekday', 'route=999&stop=1&dir=0&sched=07:00&day=weekday',
      'route=165&stop=1&dir=1&sched=07:00&day=weekday', 'route=165&stop=1&dir=2&sched=07:00&day=weekday',
      'route=165&stop=1&dir=0&sched=48:00&day=weekday', 'route=165&stop=1&dir=0&sched=7:00&day=weekday', 'route=165&stop=1&dir=0&sched=07:60&day=weekday',
      'route=165&stop=1&dir=0&sched=07:00&day=holiday', 'route=165T&stop=2&dir=0&sched=07:00&day=weekday', 'route=165&stop=nope&dir=0&sched=07:00&day=weekday',
      'route=165&stop=__proto__&dir=0&sched=07:00&day=weekday'])
      expect(q(bad), bad).toBeUndefined();
  });
  it('never carries a vehicle id, coordinate or trip id into stored cells or answers', () => {
    const trip = 'T1@20261104', samples: VehicleObservation[] = [];
    for (const date of WEEKDAYS) samples.push(moving(`T1@${date}`, at(date, '06:58:00')), stopped(`T1@${date}`, at(date, '07:03:00'), 0, '1'));
    const { events, continuity } = deriveArrivals(ds, samples);
    const cell = fill(events), answer = summarize(cell, key, 'synthetic');
    expect(answer.state).toBe('ready');
    const text = JSON.stringify([events, cell, answer]);
    for (const secret of ['SECRET-BUS', '40.9', '-74.05', 'lat', 'lon', 'vehicle', trip, 'T1@']) expect(text).not.toContain(secret);
    expect(JSON.stringify(continuity)).not.toMatch(/SECRET|40\.9|74\.05/);
    const allowed = new Set(['v', 'state', 'samples', 'minimumSamples', 'query', 'route', 'direction', 'stopId', 'scheduled', 'dayType', 'measurement', 'source',
      'firstServiceDate', 'lastServiceDate', 'oneMinute', 'fiveMinute', 'fromMinute', 'toMinute', 'count', 'worst', 'best', 'earliest', 'minutes', 'delaySeconds',
      'serviceDate', 'arrivedAt', 'uncertainty', 'boundedSamples', 'meanWindowSeconds']);
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { expect(allowed.has(k), k).toBe(true); walk(v); }
    };
    walk(answer);
  });
});
