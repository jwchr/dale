import { describe, expect, it } from 'vitest';
import { cityBoardingStops, cityDestinationStops, cityStopGroups, stopCity, changeFavoriteStops } from '../../src/domain/cityStops';
import { cityDataset } from '../helpers/cityStops';
import type { Favorite } from '../../src/domain/favorites';

describe('source-qualified city selection', () => {
  it('uses verified cities, confirmed terminal geography, or an authorized printed town prefix only', () => {
    const ds = cityDataset(), stop = ds.stops[0]!;
    expect(stopCity(ds, stop)).toBe('Fort Lee');
    ds.meta.stopCities!.state = 'unavailable';
    expect(stopCity(ds, stop)).toBe('');
    expect(stopCity(ds, ds.stops.find(s => s.id === '3')!)).toBe('New York');
    stop.name = 'Hackensack (to New York) - State Street';
    expect(stopCity(ds, stop)).toBe('');
    ds.meta.transcribed = { issued: '20261001', documentId: 'owner supplied' };
    expect(stopCity(ds, stop)).toBe('Hackensack');
    ds.meta.stopCities!.state = 'verified'; delete stop.city;
    expect(stopCity(ds, stop)).toBe('Hackensack');
  });
  it('sorts cities alphabetically, keeps unknown separate and does not mutate source order', () => {
    const ds = cityDataset(), before = structuredClone(ds.stops);
    expect(cityStopGroups(ds, ds.stops, 'es').map(g => g.city)).toEqual(['Fort Lee', 'Hackensack', 'New York', '']);
    expect(ds.stops).toEqual(before);
    ds.stops.push({ id: 'ny-local', name: 'Alphabetically earlier street', city: 'New York' });
    expect(cityStopGroups(ds, ds.stops, 'en').find(g => g.city === 'New York')!.stops[0]!.terminal).toBe('PABT');
  });
  it('filters boardings/destinations by routes and actual pickup/drop-off permissions', () => {
    const ds = cityDataset(), p = ds.patterns.find(p => p.stopIds.includes('2'))!;
    ds.patterns = [p];
    expect(cityBoardingStops(ds, [p.routeId]).map(s => s.id)).toEqual(['1', '2']);
    expect(cityBoardingStops(ds, ['missing'])).toEqual([]);
    p.noPickup = [1];
    expect(cityBoardingStops(ds, []).map(s => s.id)).toEqual(['1']);
    expect(cityDestinationStops(ds, '2', [])).toEqual([]);
    p.noPickup = []; p.noDropOff = [2];
    expect(cityDestinationStops(ds, '2', [])).toEqual([]);
    expect(cityDestinationStops(ds, '1', ['missing'])).toEqual([]);
  });
  it('retains explicit wrong-side choices without silently correcting the boarding stop', () => {
    const ds = cityDataset();
    expect(cityDestinationStops(ds, '5', []).map(s => s.id)).toContain('3');
    const favorite: Favorite = { id: 'a', label: 'Custom commute', fromStopId: '5', toStopId: '1', routeIds: [] };
    expect(changeFavoriteStops(ds, favorite, '5', '3', false)).toBeUndefined();
    expect(changeFavoriteStops(ds, favorite, '2', '3', false)?.fromStopId).toBe('2');
  });
  it('preserves favorite identity, custom labels, route filters and walking plans; reverse swaps directional plans', () => {
    const ds = cityDataset(), route = ds.patterns.find(p => p.stopIds.includes('2'))!.routeId;
    const f: Favorite = { id: 'home', label: 'My commute', fromStopId: '2', toStopId: '3', routeIds: [route], leave: { out: { walkMin: 7, cushionMin: 2 }, back: { walkMin: 3, cushionMin: 1, arriveBy: '18:00' } } };
    const original = structuredClone(f);
    expect(changeFavoriteStops(ds, f, '1', '3', false)).toEqual({ ...f, fromStopId: '1' });
    expect(changeFavoriteStops(ds, f, '3', '5', true)).toEqual({ ...f, fromStopId: '3', toStopId: '5', leave: { out: f.leave!.back, back: f.leave!.out } });
    expect(f).toEqual(original);
    expect(changeFavoriteStops(ds, { ...f, leave: { out: f.leave!.out } }, '3', '5', true)?.leave).toEqual({ back: f.leave!.out });
    expect(changeFavoriteStops(ds, { ...f, label: `${ds.stops[1]!.name} → ${ds.stops[2]!.name}` }, '1', '3', false)?.label).toBe('Bridge Plaza → PORT AUTHORITY BUS TERMINAL');
    expect(changeFavoriteStops(ds, f, 'absent', '3', false)).toBeUndefined();
    expect(changeFavoriteStops(ds, { ...f, routeIds: ['missing'] }, '1', '3', false)).toBeUndefined();
  });
});
