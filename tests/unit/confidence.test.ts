import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { demoDataset } from '../../src/data/demo';
import { createBusSession, reduceBusSession } from '../../src/domain/busLock';
import { gpsLost, offerAlternatives } from '../../src/domain/alternatives';
import { initialChecklist, JOURNEY_KEY, readChecklist, saveChecklist } from '../../src/domain/journeyGuide';
import { departuresOn, tripStopTimes, tripTimeAt } from '../../src/domain/schedule';
import { FIX_MAX_AGE_MS, tripProgress } from '../../src/domain/tripProgress';
import type { Dataset, Departure } from '../../src/domain/types';

const ds = JSON.parse(readFileSync('public/data/corridor.json', 'utf8')) as Dataset;
const dep = departuresOn(demoDataset, { stopId: 'D2', date: '20261104' })[0]!;
const now = dep.departs - 60_000;
describe('honest estimates and alternatives', () => {
  it('offers alternatives at the due time without inventing a report or changing the trip', () => {
    const selected = createBusSession(dep, now);
    const waiting = reduceBusSession(selected, { type: 'start_waiting', now });
    expect(offerAlternatives(waiting, now)).toBe(false);
    expect(offerAlternatives(waiting, dep.departs)).toBe(true);
    expect(gpsLost(waiting, dep.departs)).toBe(false);
    expect(waiting.reports).toEqual([]);
    expect(waiting.departure.tripInstanceId).toBe(dep.tripInstanceId);
    const arrived = reduceBusSession(waiting, { type: 'arrived', now: dep.departs });
    expect(offerAlternatives(arrived, dep.departs)).toBe(false);
  });
  it('offers backups on official cancellation or a witnessed pass-up before the due time', () => {
    const waiting = reduceBusSession(createBusSession(dep, now), { type: 'start_waiting', now });
    const cancelled = reduceBusSession(waiting, { type: 'official_cancellation', tripInstanceId: dep.tripInstanceId, now });
    const passed = reduceBusSession(waiting, { type: 'passed_without_stopping', now });
    expect(offerAlternatives(cancelled, now)).toBe(true);
    expect(offerAlternatives(passed, now)).toBe(true);
    expect(gpsLost(cancelled, now)).toBe(false);
  });
  it('only calls GPS lost after a received fix ages, and recovers when fresh data arrives', () => {
    const selected = createBusSession(dep, now);
    const obs = { tripInstanceId: dep.tripInstanceId, vehicleId: 'demo', lat: 40.8, lon: -74, observedAt: now };
    const fresh = reduceBusSession(selected, { type: 'observation', obs, source: 'demo', receivedAt: now });
    expect(gpsLost(fresh, now)).toBe(false);
    expect(gpsLost(fresh, now + 180_000)).toBe(true);
    expect(offerAlternatives(fresh, now + 180_000)).toBe(true);
    const recovered = reduceBusSession(fresh, { type: 'observation', obs: { ...obs, observedAt: now + 180_000 }, source: 'demo', receivedAt: now + 180_000 });
    expect(gpsLost(recovered, now + 180_000)).toBe(false);
  });
  it('expires GPS-derived milestones with GPS freshness, then keeps the timetable moving', () => {
    const times = [now, now + 300_000, now + 600_000, now + 900_000];
    const input = { stops: [], times, boardIndex: 0, alightIndex: 3, milestones: [{ index: 1, at: now + 300_000, source: 'bus_gps' as const }] };
    const a = tripProgress({ ...input, now: now + 300_000 + FIX_MAX_AGE_MS + 1 });
    const b = tripProgress({ ...input, now: now + 800_000 });
    expect(a.basis).toBe('timetable');
    expect(b.position).toBeGreaterThan(a.position);
    expect(b.reachedIndex).toBe(1);
    expect(b.delayMin).toBeUndefined();
  });
});
it('keeps checklist choices and rejects malformed saved values', () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
  const s = { ...initialChecklist(), station: 'essex' as const, step: 3, walks: { essex: 7 } };
  expect(saveChecklist(store, s)).toBe(true);
  expect(readChecklist(store)).toEqual(s);
  store.setItem(JOURNEY_KEY, '{"step":99,"walks":{"essex":-4},"station":"other"}');
  expect(readChecklist(store)).toEqual(initialChecklist());
  expect(saveChecklist(undefined, s)).toBe(false);
});
it('preserves every printed and demo stop instant across ordinary and DST service dates', () => {
  for (const data of [ds, demoDataset]) for (const date of ['20260308', '20261101', '20261104']) for (const trip of data.trips) {
    const pattern = data.patterns.find((p) => p.id === trip.patternId)!;
    const d = { tripId: trip.id, serviceDate: date, pattern } as Departure;
    expect(tripStopTimes(data, d).map((x) => x.at)).toEqual(pattern.stopIds.map((_, i) => tripTimeAt(data, trip, date, i)));
  }
});

it('preserves separate bus and train progress, including a legacy bus checklist', () => {
  const values = new Map<string, string>();
  const store = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
  const bus = { ...initialChecklist(), mode: 'bus' as const, step: 3, walks: { summit: 8 } };
  values.set(JOURNEY_KEY, JSON.stringify(bus));
  expect(readChecklist(store, 'bus')).toEqual(bus);
  expect(readChecklist(store, 'train')).toEqual(initialChecklist());
  saveChecklist(store, bus);
  const train = { ...initialChecklist(), station: 'essex' as const, step: 2 };
  saveChecklist(store, train);
  expect(readChecklist(store, 'bus')).toEqual(bus);
  expect(readChecklist(store, 'train')).toEqual(train);
  values.set(`${JOURNEY_KEY}.train`, '{"mode":"train","step":999}');
  expect(readChecklist(store, 'train').step).toBe(0);
});
