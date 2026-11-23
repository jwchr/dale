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

  it('keeps other stops separate even when codes or names match, because a tap selects one stop ID', () => {
    const ds = dataset([
      stop('code-far', 40, { code: '90001' }), stop('code-near', 10, { code: '90001' }),
      stop('named', 60, { name: 'Maple & Main' }), stop('copy', 65, { name: '  MAPLE   & MAIN  ' }),
      stop('opposite', 61, { name: 'Maple & Main', twin: 'named' }),
    ]);
    const results = nearbyStops(ds, pos, 500, 10);
    expect(results.map(x => x.stop.id)).toEqual(['code-near', 'code-far', 'named', 'opposite', 'copy']);
    expect(results.map(x => x.distanceM)).toEqual([10, 40, 60, 61, 65]);
    expect(results.every(x => x.stopIds.length === 1 && x.stopIds[0] === x.stop.id)).toBe(true);
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

  it('shows a repeated stop ID once and skips entries with invalid coordinates', () => {
    const ds = dataset([stop('a', 10), stop('invalid', NaN, { terminal: 'PABT' }), stop('platform', 20, { terminal: 'PABT' })]);
    ds.stops.push({ ...ds.stops[0]! });
    expect(nearbyStops(ds, pos)).toMatchObject([{ stop: { id: 'a' }, stopIds: ['a'] }, { stop: { id: 'platform' }, distanceM: 20, stopIds: ['platform'] }]);
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
