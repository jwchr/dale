import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { demoDataset } from '../../src/data/demo';
import { nearbyStops } from '../../src/domain/direction';
import type { Dataset, Stop } from '../../src/domain/types';
import { StopChoice } from '../../src/ui/StopChoice';
import { strings } from '../../src/ui/i18n';

// Invented positions on the equator: one degree north is ~111,195 m.
const pos = { lat: 0, lon: 0 };
function stop(id: string, metres: number, extra: Partial<Stop> = {}): Stop {
  return { id, name: id, lat: metres / 111_195, lon: 0, ...extra };
}
function dataset(stops: Stop[]): Dataset {
  return { ...demoDataset, stops: [...stops, { id: 'end', name: 'Destination', city: 'Demo town' }],
    routes: stops.map((s, i) => ({ id: `r-${s.id}`, shortName: String(160 + i), longName: 'Invented route' })),
    patterns: stops.map(s => ({ id: `p-${s.id}`, routeId: `r-${s.id}`, directionId: 0, headsign: 'Demo town', stopIds: [s.id, 'end'] })),
    trips: [],
  };
}

describe('nearby physical stops', () => {
  it('groups terminal platforms before limiting, keeps the nearest entry and all platform IDs', () => {
    const ds = dataset([
      ...Array.from({ length: 7 }, (_, i) => stop(`platform-${i}`, 20 + i, { terminal: 'PABT' })),
      stop('other', 50), stop('far-platform', 600, { terminal: 'PABT' }),
      ...Array.from({ length: 6 }, (_, i) => stop(`other-${i}`, 60 + i)),
    ]);
    const before = structuredClone(ds);
    const results = nearbyStops(ds, pos, 500, 2);
    expect(results.map(x => x.stop.id)).toEqual(['platform-0', 'other']);
    expect(results[0]!.distanceM).toBe(20);
    expect(results[0]!.stopIds).toEqual([...Array.from({ length: 7 }, (_, i) => `platform-${i}`), 'far-platform']);
    expect(nearbyStops(ds, pos).map(x => x.stop.id)).toEqual(['platform-0', 'other', 'other-0', 'other-1', 'other-2', 'other-3']);
    expect(ds).toEqual(before);
  });

  it('merges matching public codes and nearby normalized names but keeps distinct boarding places', () => {
    const ds = dataset([
      stop('code-far', 40, { code: '90001' }), stop('code-near', 10, { code: '90001' }),
      stop('named', 60, { name: 'Maple & Main' }), stop('copy', 65, { name: '  MAPLE   & MAIN  ' }),
      stop('distant', 100, { name: 'Maple & Main' }),
      stop('opposite', 61, { name: 'Maple & Main', twin: 'named' }),
      stop('code-a', 120, { name: 'Oak', code: '90002' }), stop('code-b', 121, { name: 'Oak', code: '90003' }),
    ]);
    const results = nearbyStops(ds, pos, 500, 10);
    expect(results.map(x => x.stop.id)).toEqual(['code-near', 'named', 'opposite', 'distant', 'code-a', 'code-b']);
    expect(results.map(x => x.distanceM)).toEqual([10, 60, 61, 100, 120, 121]);
    expect(results[0]!.stopIds).toEqual(['code-near', 'code-far']);
    expect(results[1]!.stopIds).toEqual(['named', 'copy']);
  });

  it('ignores entries without coordinates, arrival-only and no-pickup entries', () => {
    const ds = dataset([stop('board', 20), stop('restricted', 10), { id: 'unlocated', name: 'No coordinates' }]);
    ds.patterns[1]!.noPickup = [0];
    expect(nearbyStops(ds, pos).map(x => x.stop.id)).toEqual(['board']);
    expect(nearbyStops(ds, { lat: 30, lon: 30 })).toEqual([]);
    expect(nearbyStops(ds, pos, 500, 0)).toEqual([]);
  });

  it('uses the closest original ID even when distances round to the same metre', () => {
    const ds = dataset([stop('a-far', 10.4, { code: '90001' }), stop('z-near', 10.1, { code: '90001' })]);
    expect(nearbyStops(ds, pos)[0]).toMatchObject({ stop: { id: 'z-near' }, distanceM: 10 });
  });

  it('retains strongly identified aliases without coordinates and deduplicates repeated IDs', () => {
    const ds = dataset([stop('a', 10, { code: '90001' }), { id: 'b', name: 'Another spelling', code: '90001' }]);
    ds.stops.push({ ...ds.stops[0]! });
    expect(nearbyStops(ds, pos)).toMatchObject([{ stop: { id: 'a' }, stopIds: ['a', 'b'] }]);
  });

  it('does not let invalid coordinates hide a valid alias', () => {
    const ds = dataset([stop('invalid', NaN, { code: '90001' }), stop('valid', 20, { code: '90001' })]);
    expect(nearbyStops(ds, pos)).toMatchObject([{ stop: { id: 'valid' }, distanceM: 20, stopIds: ['valid', 'invalid'] }]);
  });

  it('does not merge stops more than 10 m apart or bridge opposite-side twins through an alias', () => {
    const ds = dataset([stop('a', 10, { name: 'Maple' }), stop('b', 12, { name: 'Maple', twin: 'a' }),
      stop('alias', 11, { name: 'Maple' }), stop('boundary', 23, { name: 'Maple' })]);
    expect(nearbyStops(ds, pos).map(x => x.stopIds)).toEqual([['a', 'alias'], ['b'], ['boundary']]);
  });

  for (const lang of ['en', 'es'] as const) it(`renders all grouped routes and destinations once (${lang})`, () => {
    const ds = dataset([stop('a', 10, { terminal: 'PABT' }), stop('b', 30, { terminal: 'PABT' })]);
    const results = nearbyStops(ds, pos);
    expect(results).toHaveLength(1);
    const row = results[0]!;
    const markup = renderToStaticMarkup(createElement(StopChoice, { ds, stop: row.stop, stopIds: row.stopIds, t: strings[lang], onPick: () => {} }));
    expect(markup).toContain('160 · 161');
    expect(markup.match(/Demo town/g)).toHaveLength(1);
    let picked: Stop | undefined;
    StopChoice({ ds, stop: row.stop, stopIds: row.stopIds, t: strings[lang], onPick: stop => { picked = stop; } }).props.onClick();
    expect(picked).toBe(ds.stops[0]);
    expect(ds.patterns.map(p => p.stopIds[0])).toEqual(['a', 'b']);
  });
});
