import { describe, expect, it } from 'vitest';
import { fixPosition, scheduledAt, stopReached, TAP_MAX_AGE_MS, timetablePosition, tripProgress, type Fix } from '../../src/domain/tripProgress';
import type { Stop } from '../../src/domain/types';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 4, 12, 0);
// Invented straight line, about 1.1 km between stops, 10 minutes apart.
const stops: Stop[] = [0, 1, 2, 3, 4].map((i) => ({ id: `S${i}`, name: `Stop ${i}`, lat: 40.9 + i * 0.01, lon: -74.0 }));
const times = stops.map((_, i) => T0 + i * 10 * MIN);
const at = (i: number, extra = 0): Fix => ({ lat: 40.9 + i * 0.01, lon: -74.0, at: extra, accuracyM: 20 });
const base = { stops, times, boardIndex: 0, alightIndex: 4, milestones: [] };

describe('trip progress while riding (owner request 2026-11-04)', () => {
  it('interpolates the timetable both ways', () => {
    expect(scheduledAt(times, 1.5)).toBe(T0 + 15 * MIN);
    expect(timetablePosition(times, T0 + 25 * MIN)).toBeCloseTo(2.5);
    expect(timetablePosition(times, T0 - MIN)).toBe(0);
    expect(timetablePosition(times, T0 + 99 * MIN)).toBe(4);
  });

  it('without evidence, shows the timetable position and claims no ahead or behind', () => {
    const p = tripProgress({ ...base, now: T0 + 15 * MIN });
    expect(p).toMatchObject({ basis: 'timetable', projected: false });
    expect(p.position).toBeCloseTo(1.5);
    expect(p.delayMin).toBeUndefined();
    expect(p.alight.projected).toBeUndefined();
  });

  it('a tap at a stop gives the delay and carries the bus forward at that pace', () => {
    // Reached stop 2 at 12:24, scheduled 12:20: 4 min behind.
    const now = T0 + 26 * MIN;
    const p = tripProgress({ ...base, now, milestones: [{ index: 2, at: T0 + 24 * MIN, source: 'tap' }] });
    expect(p).toMatchObject({ basis: 'tap', delayMin: 4, reachedIndex: 2, projected: true });
    expect(p.position).toBeCloseTo(2.2);
    expect(p.alight).toEqual({ scheduled: times[4], projected: times[4]! + 4 * MIN });
  });

  it('phone GPS between stops gives the position and delay; old or imprecise fixes are ignored', () => {
    const now = T0 + 13 * MIN;
    const mid = { lat: 40.915, lon: -74.0, at: now - 5_000, accuracyM: 25 };
    const p = tripProgress({ ...base, now, phone: mid });
    expect(p.basis).toBe('phone_gps');
    expect(p.position).toBeCloseTo(1.5, 1);
    expect(p.delayMin).toBe(-2); // where the timetable puts 12:15, at 12:13: 2 min ahead
    expect(tripProgress({ ...base, now, phone: { ...mid, at: now - 10 * MIN } }).basis).toBe('timetable');
    expect(tripProgress({ ...base, now, phone: { ...mid, accuracyM: 500 } }).basis).toBe('timetable');
  });

  it('GPS jitter never moves the bus behind a stop already reached', () => {
    const now = T0 + 22 * MIN;
    const p = tripProgress({ ...base, now, milestones: [{ index: 2, at: T0 + 21 * MIN, source: 'tap' }], phone: { lat: 40.919, lon: -74.0, at: now - 1_000, accuracyM: 20 } });
    expect(p.position).toBeGreaterThanOrEqual(2);
  });

  it('the newest evidence wins, and the bus GPS beats the phone when equally fresh', () => {
    const now = T0 + 21 * MIN;
    const p = tripProgress({ ...base, now, milestones: [{ index: 1, at: T0 + 12 * MIN, source: 'tap' }], bus: at(2, now - 2_000), phone: at(2, now - 2_000) });
    expect(p.basis).toBe('bus_gps');
    expect(p.delayMin).toBe(0); // at stop 2 at 12:20:58, scheduled 12:20: under a minute is on time
  });

  it('marks a stop reached only at the fix’s own place on the route, within 80 m, from a precise fix', () => {
    expect(stopReached(stops, 0, at(1), 1)).toBe(1);
    expect(stopReached(stops, 1, at(1), 1)).toBeUndefined();
    expect(stopReached(stops, 0, { lat: 40.912, lon: -74.0, at: 0, accuracyM: 20 }, 1.2)).toBeUndefined();
    expect(stopReached(stops, 0, { ...at(1), accuracyM: 100 }, 1)).toBeUndefined();
    expect(stopReached(stops, 0, at(1), undefined)).toBeUndefined();
  });

  it('on a street that doubles back, a fix near B never marks the later stop on the parallel side', () => {
    // A → B → C goes north, then D → E comes back south one block east: E sits 30 m from B.
    const loop: Stop[] = [
      { id: 'A', name: 'A', lat: 40.900, lon: -74.0 }, { id: 'B', name: 'B', lat: 40.910, lon: -74.0 },
      { id: 'C', name: 'C', lat: 40.920, lon: -74.0 }, { id: 'D', name: 'D', lat: 40.920, lon: -73.9996 },
      { id: 'E', name: 'E', lat: 40.910, lon: -73.9996 },
    ];
    const fix = { lat: 40.9102, lon: -73.99972, at: T0, accuracyM: 15 }; // 32 m from B, 24 m from E
    const pos = fixPosition(loop, 0, fix, T0);
    expect(stopReached(loop, 0, fix, pos)).not.toBe(4);
  });

  it('an estimate never passes the next stop, and an old tap stops counting as evidence', () => {
    // Reached stop 1 a minute late; 15 minutes on with nothing new.
    const tapped = { ...base, milestones: [{ index: 1, at: T0 + 11 * MIN, source: 'tap' as const }] };
    const p = tripProgress({ ...tapped, now: T0 + 26 * MIN });
    expect(p.position).toBeLessThan(2);
    expect(p.projected).toBe(true);
    expect(p.reachedIndex).toBe(1);
    // Two hours later the tap says nothing about now: back to the timetable, stop 1 still reached.
    const later = tripProgress({ ...tapped, now: T0 + 11 * MIN + TAP_MAX_AGE_MS + MIN });
    expect(later.basis).toBe('timetable');
    expect(later.delayMin).toBeUndefined();
    expect(later.reachedIndex).toBe(1);
  });

  it('needs every stop located to use GPS at all (the printed timetable has none)', () => {
    const unlocated = stops.map((s) => ({ id: s.id, name: s.name }));
    expect(fixPosition(unlocated, 0, at(1, T0), T0)).toBeUndefined();
    expect(tripProgress({ ...base, stops: unlocated, now: T0 + 5 * MIN, phone: at(1, T0 + 5 * MIN) }).basis).toBe('timetable');
  });
});

it('fresh bus GPS stays at its observed position between polls, without timetable carry-forward',()=>{
 const observed=T0+10*MIN, fix=at(1,observed);
 for(const seconds of [0,30,90]){
  const p=tripProgress({...base,now:observed+seconds*1000,bus:fix});
  expect(p.basis).toBe('bus_gps');expect(p.position).toBeCloseTo(1);expect(p.projected).toBe(false);expect(p.observedAt).toBe(observed);
 }
 expect(tripProgress({...base,now:observed+121000,bus:fix}).basis).toBe('timetable');
});
