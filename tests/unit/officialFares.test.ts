import { describe, expect, it } from 'vitest';
// @ts-expect-error deployment script is ESM
import { addOfficialFares, addZoneChecks, crossStreets, MIN_ANCHORS, town } from '../../scripts/official-fares.mjs';
import { parseDataset } from '../../src/domain/dataset';
import { fareBetween } from '../../src/domain/fare';
import { strings } from '../../src/ui/i18n';
import type { Dataset } from '../../src/domain/types';

// Synthetic only: a printed route with 18 timepoints, Port Authority first, and an official schedule whose
// stops carry the same towns and cross streets, with one unprinted stop after each timepoint (#238).
type Band = number[];
const ZONES: Band[] = [[1], [2], [2], [2, 3], [3], [3], [3], [3, 4], [4], [4], [4], [4], [5], [5], [5], [5], [5], [5]];
const N = ZONES.length;

function printed(over: { zones?: (dir: string, k: number) => Band | undefined; where?: (k: number) => string | undefined } = {}) {
  const tp = (k: number) => ({ ref: k + 1, city: k === 0 ? 'New York' : `Town${k} (Mall)`, where: k === 0 ? 'Port Authority Bus Terminal' : over.where?.(k) ?? `Main St. at Elm${k} Avenue` });
  const out = [...Array(N).keys()].map(tp);
  const zones = (dir: string) => Object.fromEntries(out.map((t, k) => [t.ref, over.zones?.(dir, k) ?? ZONES[k]]));
  return {
    timepoints: { toWestwood: out, toNewYork: [...out].reverse() },
    fares: {
      source: 'printed-165', effective: '20261101', zones: { toWestwood: zones('toWestwood'), toNewYork: zones('toNewYork') },
      cashCents: {
        withinNewJersey: { adult: { 1: 190, 2: 300, 3: 380, 4: 455 }, reduced: { 1: 85, 2: 125, 3: 160, 4: 210 } },
        toFromNewYork: { adult: { 2: 420, 3: 545, 4: 730, 5: 845 }, reduced: { 2: 185, 3: 245, 4: 320, 5: 385 } },
      },
    },
  };
}

function official(extra: { stops?: Dataset['stops']; out?: string[] } = {}): Dataset {
  const stops: Dataset['stops'] = [{ id: 'P1', name: 'PORT AUTHORITY BUS TERMINAL', terminal: 'PABT' }];
  const out = ['P1'];
  for (let k = 1; k < N; k++) {
    stops.push({ id: `A${k}`, name: `ELM${k} AVE AT MAIN ST`, city: `TOWN${k} TWP` }, { id: `M${k}`, name: `MID ${k}`, city: `TOWN${k} TWP` });
    out.push(`A${k}`, `M${k}`);
  }
  stops.push(...(extra.stops ?? []));
  const outIds = extra.out ?? out;
  const all = [true, true, true, true, true, true, true];
  return {
    meta: { demo: false, source: 'synthetic', feedVersion: 'x', builtAt: '2026-11-20T00:00:00Z', timezone: 'America/New_York' },
    routes: [{ id: 'R165', shortName: '165', longName: 't' }, { id: 'R165T', shortName: '165T', longName: 't' }, { id: 'R163', shortName: '163', longName: 't' }],
    stops,
    patterns: [
      { id: 'out', routeId: 'R165', directionId: 0, headsign: 'WESTWOOD', stopIds: outIds },
      { id: 'in', routeId: 'R165T', directionId: 1, headsign: 'NEW YORK', stopIds: [...outIds].reverse() },
      { id: 'other', routeId: 'R163', directionId: 0, headsign: 'RIDGEWOOD', stopIds: ['P1', 'A1', 'A9'] },
    ],
    trips: [
      { id: 'o', patternId: 'out', serviceId: 'S', times: outIds.map((_, i) => 8 * 3600 + i * 60) },
      { id: 'i', patternId: 'in', serviceId: 'S', times: outIds.map((_, i) => 9 * 3600 + i * 60) },
      { id: 'x', patternId: 'other', serviceId: 'S', times: [7 * 3600, 7 * 3600 + 60, 7 * 3600 + 120] },
    ],
    calendars: { S: { days: all, start: '20261101', end: '20261130', added: [], removed: [] } },
  } as unknown as Dataset;
}

const run = (ds: Dataset, doc = printed()) => addOfficialFares(ds, doc) as { ds: Dataset; report: Record<string, any> };
const zonesOf = (ds: Dataset) => ds.publishedFares!.stopZones;

describe('printed fare zones on official stops', () => {
  it('normalizes cross streets and towns the way both sources write them', () => {
    expect(crossStreets('Main St. at Elm3 Avenue')).toEqual(crossStreets('ELM3 AVE AT MAIN ST'));
    expect(crossStreets('Boulevard East - 49th St')).toEqual(['49TH ST', 'BLVD E']);
    expect(crossStreets('Port Authority Bus Terminal')).toBeUndefined();
    expect(town('Hackensack (Sears)')).toBe('HACKENSACK');
    expect(town('WEEHAWKEN TWP')).toBe('WEEHAWKEN');
  });

  it('anchors every printed timepoint once, gives it its printed band, and passes the dataset check', () => {
    const { ds, report } = run(official());
    expect(report).toMatchObject({ added: true, anchors: { toWestwood: N, toNewYork: N }, of: { toWestwood: N, toNewYork: N } });
    expect(zonesOf(ds).P1).toEqual([1, 1]);
    expect(zonesOf(ds).A4).toEqual([3, 3]);
    expect(zonesOf(ds).A3).toEqual([2, 3]);
    expect(ds.publishedFares).toMatchObject({ matched: true, routeIds: ['R165', 'R165T'], newYorkStopIds: ['P1'] });
    expect(() => parseDataset(JSON.parse(JSON.stringify(ds)))).not.toThrow();
    // No stop IDs in the report: only counts.
    expect(JSON.stringify(report)).not.toMatch(/A\d|M\d|P1/);
  });

  it('gives a stop between two timepoints in different zones both zones, never one by guessing', () => {
    const z = zonesOf(run(official()).ds);
    expect(z.M2).toEqual([2, 3]); // between Elm2 (zone 2) and Elm3 (zone 2 or 3)
    expect(z.M5).toEqual([3, 3]);
    expect(z.M11).toEqual([4, 5]);
  });

  it('gives no zone where the gap between two timepoints spans three zones', () => {
    const doc = printed({ zones: (_, k) => (k === 6 ? [3] : k === 7 ? [5] : k > 7 ? [5] : undefined) });
    const z = zonesOf(run(official(), doc).ds);
    expect(z.M6).toBeUndefined();
    expect(z.A7).toEqual([5, 5]);
  });

  it('leaves a misspelled or duplicated cross street unanchored, and the stops around it keep the wider band', () => {
    // Elm3 (the 2-or-3 boundary) is misspelled in print, so it does not anchor; stops from Elm2 to Elm4 get 2 or 3.
    const typo = run(official(), printed({ where: (k) => (k === 3 ? 'Main St. at Elmm3 Avenue' : undefined) }));
    expect(typo.report.anchors.toWestwood).toBe(N - 1);
    expect(zonesOf(typo.ds).A3).toEqual([2, 3]);
    expect(zonesOf(typo.ds).M2).toEqual([2, 3]);
    expect(zonesOf(typo.ds).M3).toEqual([2, 3]);
    // Two Elm5 stops in one pattern: neither anchors.
    const base = official();
    const out = base.patterns[0]!.stopIds.flatMap((id) => (id === 'M5' ? [id, 'D5'] : [id]));
    const dup = run(official({ stops: [{ id: 'D5', name: 'MAIN ST AT ELM5 AVE', city: 'TOWN5' }], out }));
    expect(dup.report.anchors.toWestwood).toBe(N - 1);
    expect(zonesOf(dup.ds).A5).toEqual([3, 3]); // still between Elm4 and Elm6, all zone 3
  });

  it('adds no fares at all when too few timepoints anchor in either direction', () => {
    const broken = N - MIN_ANCHORS + 1;
    const doc = printed({ where: (k) => (k >= 1 && k <= broken ? `Nowhere${k} Rd at Lost Ln` : undefined) });
    const ds = official();
    const { ds: same, report } = run(ds, doc);
    expect(report.added).toBe(false);
    expect(same).toBe(ds);
    expect(same.publishedFares).toBeUndefined();
  });

  it('joins the two directions: a stop each direction prints in a different zone gets both, or none when they are further apart', () => {
    const near = zonesOf(run(official(), printed({ zones: (dir, k) => (k === 5 && dir === 'toNewYork' ? [4] : undefined) })).ds);
    expect(near.A5).toEqual([3, 4]);
    const far = zonesOf(run(official(), printed({ zones: (dir, k) => (k === 5 && dir === 'toNewYork' ? [5] : undefined) })).ds);
    expect(far.A5).toBeUndefined();
  });

  it('reads direction per route: a 165T bound for New York may share a direction number with a 165 leaving it (CodeRabbit, #246)', () => {
    const ds = official();
    const shared = { ...ds, patterns: ds.patterns.map((p) => (p.id === 'in' ? { ...p, directionId: 0 as const } : p)) };
    expect(run(shared).report).toMatchObject({ added: true, anchors: { toWestwood: N, toNewYork: N } });
  });

  it('prices route 165 and 165T trips, never a 163 between the same stops', () => {
    const { ds } = run(official());
    expect(fareBetween(ds, 'R165', 'P1', 'A9')?.zones).toEqual({ min: 4, max: 4 });
    expect(fareBetween(ds, 'R165T', 'A9', 'P1')?.newYork).toBe(true);
    expect(fareBetween(ds, 'R163', 'P1', 'A9')).toBeUndefined();
  });
});

describe('hand-checked trip planner zones', () => {
  const entry = (over = {}) => ({ direction: 'toWestwood', name: 'ELM3 AVE AT MAIN ST', town: 'TOWN3', zone: 3, ...over });
  const file = (stops = [entry()]) => ({ source: 'Synthetic trip planner checks', checked: '20261121', stops });
  const apply = (ds: Dataset, checks = file()) => addZoneChecks(ds, checks) as {
    ds: Dataset; report: Record<string, number>;
  };

  it('narrows a two-zone band, keeps provenance, gives a single fare and passes dataset validation', () => {
    const before = run(official()).ds;
    expect(fareBetween(before, 'R165', 'P1', 'A3')?.adult).toEqual({ min: 420, max: 545 });
    const checks = file([entry({ name: ' elm3 ave at main st ', town: 'Town3 (Mall)' })]);
    const { ds, report } = apply(before, checks);
    expect(zonesOf(ds).A3).toEqual([3, 3]);
    expect(zonesOf(before).A3).toEqual([2, 3]);
    expect(fareBetween(ds, 'R165', 'P1', 'A3')).toMatchObject({ zones: { min: 3, max: 3 }, adult: { min: 545, max: 545 } });
    expect(ds.publishedFares?.checked).toEqual({ source: checks.source, date: checks.checked });
    expect(parseDataset(JSON.parse(JSON.stringify(ds)))).toEqual(ds);
    expect(report).toEqual({ entries: 1, applied: 1, narrowed: 1, filled: 0, same: 0, conflicts: 0, disagree: 0, unmatched: 0 });
    expect(Object.values(report).every((n) => Number.isInteger(n))).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/A\d|M\d|P1|ELM|TOWN/);
  });

  it('fills a stop with no band', () => {
    const before = run(official()).ds;
    expect(zonesOf(before).M17).toBeUndefined();
    const { ds, report } = apply(before, file([entry({ name: 'MID 17', town: 'TOWN17', zone: 5 })]));
    expect(zonesOf(ds).M17).toEqual([5, 5]);
    expect(report).toMatchObject({ applied: 1, filled: 1, narrowed: 0, conflicts: 0 });
  });

  it('replaces a band that disagrees with the official answer and counts the conflict', () => {
    const { ds, report } = apply(run(official()).ds, file([entry({ zone: 4 })]));
    expect(zonesOf(ds).A3).toEqual([4, 4]);
    expect(report).toMatchObject({ applied: 1, conflicts: 1, narrowed: 0 });
  });

  it('counts agreeing checks once per stop and recognizes an already exact band', () => {
    const before = run(official()).ds;
    const checks = file([entry(), entry({ direction: 'toNewYork' })]);
    const first = apply(before, checks);
    expect(first.report).toMatchObject({ entries: 2, applied: 1, narrowed: 1, disagree: 0 });
    const second = apply(first.ds, checks);
    expect(second.report).toMatchObject({ entries: 2, applied: 1, same: 1, narrowed: 0 });
    expect(second.ds).toEqual(first.ds);
  });

  it('leaves absent and ambiguous matches unchanged', () => {
    const base = official();
    const out = base.patterns[0]!.stopIds.flatMap((id) => id === 'A3' ? [id, 'D3'] : [id]);
    const before = run(official({ stops: [{ id: 'D3', name: 'ELM3 AVE AT MAIN ST', city: 'TOWN3' }], out })).ds;
    const { ds, report } = apply(before, file([entry(), entry({ name: 'MISSING STOP' })]));
    expect(zonesOf(ds)).toEqual(zonesOf(before));
    expect(report).toMatchObject({ entries: 2, applied: 0, unmatched: 2 });
  });

  it('requires the named town as well as the exact official name', () => {
    const before = run(official()).ds;
    const { ds, report } = apply(before, file([entry({ town: 'ANOTHER TOWN' }), entry({ name: 'MAIN ST AT ELM3 AVE' })]));
    expect(zonesOf(ds)).toEqual(zonesOf(before));
    expect(report).toMatchObject({ applied: 0, unmatched: 2 });
  });

  it('does not apply an inbound check to an outbound-only stop', () => {
    const base = official();
    base.patterns[1]!.stopIds = base.patterns[1]!.stopIds.filter((id) => id !== 'A3');
    const before = run(base).ds;
    const { ds, report } = apply(before, file([entry({ direction: 'toNewYork' })]));
    expect(zonesOf(ds)).toEqual(zonesOf(before));
    expect(report).toMatchObject({ applied: 0, unmatched: 1 });
  });

  it('uses route-specific directions and inherits them for patterns without a terminal', () => {
    const base = official();
    base.patterns[1]!.directionId = 0;
    base.stops.push({ id: 'SHORT', name: 'SHORT TURN STOP', city: 'TOWN3' });
    base.patterns.push({ id: 'short', routeId: 'R165T', directionId: 0, headsign: 'NEW YORK', stopIds: ['SHORT', 'A3'] });
    const { ds, report } = apply(run(base).ds, file([entry({ direction: 'toNewYork', name: 'SHORT TURN STOP' })]));
    expect(zonesOf(ds).SHORT).toEqual([3, 3]);
    expect(report).toMatchObject({ applied: 1, filled: 1, unmatched: 0 });
  });

  it('ignores stops served only by routes outside the published fare table', () => {
    const base = official();
    base.stops.push({ id: 'OTHER', name: 'OTHER ROUTE STOP', city: 'TOWN3' });
    base.patterns[2]!.stopIds.push('OTHER');
    const before = run(base).ds;
    const { ds, report } = apply(before, file([entry({ name: 'OTHER ROUTE STOP' })]));
    expect(zonesOf(ds)).toEqual(zonesOf(before));
    expect(report).toMatchObject({ applied: 0, unmatched: 1 });
  });

  it('removes the band when checks in opposite directions disagree, in either order', () => {
    const before = run(official()).ds;
    const entries = [entry(), entry({ direction: 'toNewYork', zone: 4 })];
    for (const stops of [entries, [...entries].reverse()]) {
      const { ds, report } = apply(before, file(stops));
      expect(zonesOf(ds).A3).toBeUndefined();
      expect(fareBetween(ds, 'R165', 'P1', 'A3')).toBeUndefined();
      expect(report).toEqual({ entries: 2, applied: 0, narrowed: 0, filled: 0, same: 0, conflicts: 0, disagree: 1, unmatched: 0 });
    }
    expect(zonesOf(before).A3).toEqual([2, 3]);
  });

  it('never changes a terminal PABT stop, even with a matching name and town', () => {
    const base = official();
    base.stops[0]!.city = 'NEW YORK';
    const before = run(base).ds;
    const { ds, report } = apply(before, file([entry({ name: 'PORT AUTHORITY BUS TERMINAL', town: 'NEW YORK', zone: 8 })]));
    expect(zonesOf(ds)).toEqual(zonesOf(before));
    expect(zonesOf(ds).P1).toEqual([1, 1]);
    expect(report).toMatchObject({ applied: 0, unmatched: 1 });
  });

  it.each([undefined, false])('returns the same dataset when matched fares are %s', (matched) => {
    const before = matched === undefined ? official() : run(official()).ds;
    if (before.publishedFares) before.publishedFares.matched = matched;
    const { ds, report } = apply(before);
    expect(ds).toBe(before);
    expect(report).toEqual({ entries: 1, applied: 0, narrowed: 0, filled: 0, same: 0, conflicts: 0, disagree: 0, unmatched: 0 });
  });

  it.each([
    [null, /source/],
    [{ ...file(), source: undefined }, /source/],
    [{ ...file(), source: '  ' }, /source/],
    [{ ...file(), checked: '2026-11-21' }, /checked/],
    [{ ...file(), checked: '20260229' }, /checked/],
    [{ ...file(), checked: 20261121 }, /checked/],
    [{ ...file(), stops: {} }, /stops/],
    [{ ...file(), stops: [null] }, /direction/],
    [file([entry({ direction: 'outbound' })]), /direction/],
    [file([entry({ name: ' ' })]), /name/],
    [file([entry({ town: '' })]), /town/],
    [file([entry({ zone: 0 })]), /zone/],
    [file([entry({ zone: 2.5 })]), /zone/],
    [file([entry({ zone: '3' })]), /zone/],
    [file([entry(), entry({ name: ' elm3 ave at main st ', town: 'Town3 TWP' })]), /duplicate/],
  ])('rejects invalid check files (%#)', (checks, message) => {
    const before = run(official()).ds;
    expect(() => addZoneChecks(before, checks)).toThrow(message);
    expect(zonesOf(before).A3).toEqual([2, 3]);
  });

  it.each([null, { source: ' ', date: '20261121' }, { source: 'Synthetic', date: '20260229' }])('rejects invalid checked provenance (%#)', (checked) => {
    const ds = apply(run(official()).ds).ds;
    expect(() => parseDataset({ ...ds, publishedFares: { ...ds.publishedFares, checked } })).toThrow('Invalid schedule dataset');
  });
});

describe('fare zone label', () => {
  it('says "or" for two adjacent counts and the whole range when a third is possible (CodeRabbit, #246)', () => {
    expect(strings.en.fareZones(3, 3)).toBe('3 zones');
    expect(strings.en.fareZones(2, 3)).toBe('2 or 3 zones');
    expect(strings.en.fareZones(2, 4)).toBe('2 to 4 zones');
    expect(strings.es.fareZones(2, 3)).toBe('2 o 3 zonas');
    expect(strings.es.fareZones(2, 4)).toBe('entre 2 y 4 zonas');
  });
});
