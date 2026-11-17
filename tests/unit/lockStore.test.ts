import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { demoDataset } from '../../src/data/demo';
import { createBusSession, reduceBusSession } from '../../src/domain/busLock';
import { forgetLock, LIVE_LOCK_KEY, loadLock, LOCK_KEY, saveLock, savedLockSessionId } from '../../src/domain/lockStore';
import { departuresOn } from '../../src/domain/schedule';
import type { Dataset } from '../../src/domain/types';

const ds = JSON.parse(readFileSync('public/data/corridor.json', 'utf8')) as Dataset;
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };
const dep = departuresOn(ds, { stopId: 'N19', toStopId: 'PABT', date: '20261104' })[3]!;
const leg = { fromStopId: 'N19', toStopId: 'PABT', routeIds: [] as string[] };
const lockedAt = dep.departs - 10 * 60_000;
const waiting = () => reduceBusSession(createBusSession(dep, lockedAt), { type: 'start_waiting', now: lockedAt + 60_000 });

describe('Bus Lock kept on this phone (issue #53)', () => {
  it('round-trips the exact departure, leg and reports with their original times', () => {
    const store = memory();
    const session = reduceBusSession(waiting(), { type: 'no_bus', now: dep.departs + 2 * 60_000 });
    saveLock(store, ds, { dep, leg, session }, dep.departs + 3 * 60_000);
    const back = loadLock<typeof leg>(store, ds, dep.departs + 20 * 60_000)!;
    expect(back.dep.tripInstanceId).toBe(dep.tripInstanceId);
    expect(back.leg).toEqual(leg);
    expect(back.session.reports.map((r) => [r.kind, r.reportedAt])).toEqual([['no_bus', dep.departs + 2 * 60_000]]);
    expect(back.session.waitingSince).toBe(lockedAt + 60_000);
  });

  it('is not offered for another schedule, a trip that is gone, a finished session, or long after the trip', () => {
    const store = memory();
    const save = () => saveLock(store, ds, { dep, leg, session: waiting() }, lockedAt + 60_000);
    save();
    expect(loadLock(store, { ...ds, meta: { ...ds.meta, feedVersion: 'other' } }, dep.departs)).toBeUndefined();
    expect(store.m.has(LOCK_KEY)).toBe(false); // an invalid lock is forgotten
    save();
    expect(loadLock(store, { ...ds, trips: ds.trips.filter((t) => t.id !== dep.tripId) }, dep.departs)).toBeUndefined();
    save();
    expect(loadLock(store, ds, dep.arrivesEnd + 3 * 3600_000)).toBeUndefined();
    save();
    expect(loadLock(store, ds, lockedAt - 60_000)).toBeUndefined(); // clock set back before the lock
    const ended = reduceBusSession(waiting(), { type: 'end', now: lockedAt + 2 * 60_000 });
    saveLock(store, ds, { dep, leg, session: ended }, lockedAt + 2 * 60_000);
    expect(store.m.has(LOCK_KEY)).toBe(false);
  });

  it('never touches a real saved lock from the demo, and catches a clock set back past the last action', () => {
    const store = memory();
    saveLock(store, ds, { dep, leg, session: waiting() }, lockedAt + 60_000);
    expect(loadLock(store, demoDataset, lockedAt + 2 * 60_000)).toBeUndefined();
    saveLock(store, demoDataset, undefined, lockedAt + 2 * 60_000);
    expect(store.m.has(LOCK_KEY)).toBe(true); // still there for the real schedule
    expect(loadLock(store, ds, lockedAt + 30_000)).toBeUndefined(); // after the lock was made, before its last action
    saveLock(store, ds, { dep, leg, session: waiting() }, lockedAt + 60_000);
    store.setItem(LOCK_KEY, JSON.stringify({ ...JSON.parse(store.getItem(LOCK_KEY)!), session: { ...waiting(), reports: 'x' } }));
    expect(loadLock(store, ds, lockedAt + 2 * 60_000)).toBeUndefined(); // an unknown shape is dropped
  });

  it('tells every tab which lock is saved, without a schedule and without forgetting it (locked-phone alerts)', () => {
    const store = memory();
    const session = waiting();
    saveLock(store, ds, { dep, leg, session }, lockedAt + 60_000);
    expect(savedLockSessionId(store, dep.departs)).toBe(session.id);
    expect(savedLockSessionId(store, dep.arrivesEnd + 3 * 3600_000)).toBeUndefined(); // long past the trip
    expect(store.m.has(LOCK_KEY)).toBe(true); // only read, never forgotten
    expect(savedLockSessionId(store, dep.departs, LIVE_LOCK_KEY)).toBeUndefined(); // live mode keeps its own lock
    store.setItem(LIVE_LOCK_KEY, store.getItem(LOCK_KEY)!);
    expect(savedLockSessionId(store, dep.departs, LIVE_LOCK_KEY)).toBe(session.id);
    forgetLock(store);
    expect(savedLockSessionId(store, dep.departs)).toBeUndefined(); // unlocked
    store.setItem(LOCK_KEY, JSON.stringify({ v: 1, dep, leg, session: { ...session, phase: 'left' } }));
    expect(savedLockSessionId(store, dep.departs)).toBeUndefined(); // got off
    store.setItem(LOCK_KEY, '{not json');
    expect(savedLockSessionId(store, dep.departs)).toBeUndefined();
    expect(savedLockSessionId({ getItem: () => { throw new Error('blocked'); }, setItem: () => {}, removeItem: () => {} }, dep.departs)).toBeUndefined();
  });

  it('never keeps the invented demo, and survives storage errors', () => {
    const store = memory();
    const demoDep = departuresOn(demoDataset, { stopId: 'D2', toStopId: 'PABT', date: '20261104' })[0]!;
    saveLock(store, demoDataset, { dep: demoDep, leg, session: createBusSession(demoDep, demoDep.departs) }, demoDep.departs);
    expect(store.m.has(LOCK_KEY)).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(() => saveLock(broken, ds, { dep, leg, session: waiting() }, lockedAt)).not.toThrow();
    expect(loadLock(broken, ds, lockedAt)).toBeUndefined();
    expect(() => forgetLock(broken)).not.toThrow();
    store.setItem(LOCK_KEY, '{not json');
    expect(loadLock(store, ds, lockedAt)).toBeUndefined();
  });
});

// Regression: JSON can parse successfully while nested objects are unusable.
it('forgets malformed nested saved state without crashing startup', () => {
  const corruptions = [
    (x: any) => { x.dep.pattern.stopIds = null; },
    (x: any) => { x.session.history = [null]; },
    (x: any) => { x.session.reports = [null]; },
    (x: any) => { x.session.departure.pattern = null; },
    (x: any) => { x.leg = null; },
    (x: any) => { x.dep.route = null; },
    (x: any) => { x.session.waitingSince = 'invalid'; },
    (x: any) => { x.session.lastReceivedAt = {}; },
    (x: any) => { x.session.pendingPosition = null; },
  ];
  for (const corrupt of corruptions) {
    const store = memory();
    saveLock(store, ds, { dep, leg, session: waiting() }, lockedAt + 60_000);
    const value = JSON.parse(store.getItem(LOCK_KEY)!);
    corrupt(value);
    store.setItem(LOCK_KEY, JSON.stringify(value));
    expect(loadLock(store, ds, dep.departs)).toBeUndefined();
    expect(store.getItem(LOCK_KEY)).toBeNull();
  }
});
