import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { confidenceKeyFor } from '../../src/domain/arrivalConfidence';
import { createBusSession } from '../../src/domain/busLock';
import { fareBetween } from '../../src/domain/fare';
import { loadFavorites, saveFavorites } from '../../src/domain/favorites';
import { loadLock, saveLock } from '../../src/domain/lockStore';
import { routeHeadsign, routeLabel, routeList, routeNumber } from '../../src/domain/routeDisplay';
import { departuresOn } from '../../src/domain/schedule';
import { boardingInfo } from '../../src/domain/stopInfo';
import { stopSignLines, stopSignRoutes } from '../../src/domain/stopSign';
import type { Dataset } from '../../src/domain/types';

const printed = JSON.parse(readFileSync('public/data/corridor.json', 'utf8')) as Dataset;

describe('NJ Transit route 165 presentation', () => {
  it('shows the agency number while keeping express choices and other variants distinct', () => {
    expect(['163', '164', '165', '165T', '165P', '165R'].map(routeNumber)).toEqual(['163', '164', '165', '165', '165P', '165R']);
    expect(routeList(['165', '165T', '165T'])).toBe('165, 165 · Turnpike Exp');
    expect(routeLabel('165')).toBe('165');
    expect(routeHeadsign('165T NEW YORK TURNPIKE EXP')).toBe('165 NEW YORK TURNPIKE EXP');
    expect(routeHeadsign('165T WESTWOOD')).toBe('165 WESTWOOD · Turnpike Exp');
    expect(routeHeadsign('165 NEW YORK', '165T')).toBe('165 NEW YORK · Turnpike Exp');
    expect(routeHeadsign('165 NEW YORK')).toBe('165 NEW YORK');
    expect(routeHeadsign('165P NEW YORK PARKWAY EXP')).toBe('165P NEW YORK PARKWAY EXP');
  });

  it('keeps a saved Turnpike commute, exact lock, history key and printed fare intact after display', () => {
    const ds = structuredClone(printed), before = JSON.stringify(ds);
    const entries = new Map<string, string>();
    const store = { getItem: (k: string) => entries.get(k) ?? null,
      setItem: (k: string, v: string) => { entries.set(k, v); }, removeItem: (k: string) => { entries.delete(k); } };
    const favorite = { id: 'express', label: 'Home', fromStopId: 'N19', toStopId: 'PABT', routeIds: ['R165T'] };
    saveFavorites(store, [favorite]);
    const saved = loadFavorites(store)[0]!;
    const dep = departuresOn(ds, { stopId: saved.fromStopId, toStopId: saved.toStopId, routeIds: saved.routeIds, date: '20261104' })[0]!;
    const key = confidenceKeyFor(ds, dep), fare = fareBetween(ds, dep.route.id, saved.fromStopId, saved.toStopId);
    const now = dep.departs - 60_000;
    saveLock(store, ds, { dep, leg: favorite, session: createBusSession(dep, now) }, now);
    expect(routeNumber(dep.route.shortName)).toBe('165');
    expect(routeHeadsign(dep.pattern.headsign, dep.route.shortName)).toContain('Turnpike');
    const restored = loadLock<typeof favorite>(store, ds, now)!;
    expect(restored.dep.tripInstanceId).toBe(dep.tripInstanceId);
    expect(restored.dep.route.id).toBe('R165T');
    expect(restored.leg.routeIds).toEqual(['R165T']);
    expect(loadFavorites(store)).toEqual([favorite]);
    expect(key?.route).toBe('165T');
    expect(confidenceKeyFor(ds, restored.dep)).toEqual(key);
    expect(fare).toBeDefined();
    expect(fareBetween(ds, restored.dep.route.id, saved.fromStopId, saved.toStopId)).toEqual(fare);
    expect(JSON.stringify(ds)).toBe(before);
  });

  it('uses 165 on stop signs and stop details without exposing or duplicating the internal suffix', () => {
    expect(stopSignRoutes(printed, 'N19', 'PABT', [])).toEqual(['165']);
    expect(stopSignRoutes(printed, 'N19', 'PABT', ['R165T'])).toEqual(['165']);
    const lines = stopSignLines(printed, 'N19', 'PABT', ['R165T']);
    expect(lines.some(l => l.route === '165' && l.yours)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('165T');
    const info = boardingInfo(printed, 'N19');
    expect(info.routes).toEqual(['165']);
    expect(info.headsigns.some(h => h.includes('Turnpike Exp'))).toBe(true);
    expect(JSON.stringify(info)).not.toContain('165T');
  });
});
