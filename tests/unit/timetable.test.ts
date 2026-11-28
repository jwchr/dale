import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { buildTimetableDataset } from '../../scripts/timetable-lib.mjs';
import { demoDataset } from '../../src/data/demo';
import { alightingStopFor, checkDirection, destinationsFrom, returnLeg, searchStops } from '../../src/domain/direction';
import { fareBetween } from '../../src/domain/fare';
import { gateFor, publishedGateFor } from '../../src/domain/gate';
import { isNjtHoliday, njtHolidaysIn } from '../../src/domain/holidays';
import { departuresOn, timeBaseOf, tripTimeAt } from '../../src/domain/schedule';
import { formatTime12 } from '../../src/domain/time';
import type { Dataset } from '../../src/domain/types';
import { strings } from '../../src/ui/i18n';

const root = join(__dirname, '../..');
const doc = JSON.parse(readFileSync(join(root, 'data/t0165/transcription.json'), 'utf8'));
const committed = JSON.parse(readFileSync(join(root, 'public/data/corridor.json'), 'utf8')) as Dataset;
const ds = buildTimetableDataset(doc, { builtAt: committed.meta.builtAt }) as Dataset;
const TZ = 'America/New_York';
const fmt = (t: number) => formatTime12(t, TZ);
const patternOf = (id: string) => ds.patterns.find((p) => p.id === id)!;

describe('route 165 printed-timetable dataset', () => {
  it('is what the build script produces from the checked-in transcription', () => {
    expect(committed).toEqual(ds);
  });

  it('keeps every printed row as one trip (500 rows) and is honest about its source', () => {
    expect(ds.trips).toHaveLength(500);
    expect(new Set(ds.trips.map((t) => t.id)).size).toBe(500);
    expect(ds.meta.demo).toBe(false);
    expect(ds.meta.transcribed).toEqual({ issued: '20260701', documentId: 'T0165 - 7/26' });
    expect(ds.stops.every((s) => s.lat === undefined && s.lon === undefined)).toBe(true);
    expect(ds.trips.every((t) => t.estimated === undefined)).toBe(true);
  });

  it('has consistent references and plausible times on every trip', () => {
    const stopIds = new Set(ds.stops.map((s) => s.id));
    for (const p of ds.patterns) expect(p.stopIds.every((id) => stopIds.has(id))).toBe(true);
    for (const t of ds.trips) {
      const p = patternOf(t.patternId);
      expect(t.times).toHaveLength(p.stopIds.length);
      expect(ds.calendars[t.serviceId]).toBeDefined();
      for (let i = 1; i < t.times.length; i++) {
        const step = (t.times[i]! - t.times[i - 1]!) / 60;
        expect(step, `${t.id} stop ${i}`).toBeGreaterThanOrEqual(0);
        expect(step, `${t.id} stop ${i}`).toBeLessThanOrEqual(45);
      }
      expect(t.times[t.times.length - 1]!).toBeLessThan(27 * 3600);
    }
    // Direction 0 patterns all end at the terminal; PABT is the only stop shared by both directions.
    for (const p of ds.patterns.filter((x) => x.directionId === 0)) expect(p.stopIds.at(-1)).toBe('PABT');
    expect(ds.stops.filter((s) => s.terminal === 'PABT')).toHaveLength(1);
  });

  it('routes only T-marked trips to 165T and records the marker on the pattern', () => {
    for (const p of ds.patterns) {
      expect(p.routeId === 'R165T').toBe(p.variant === 'T');
      expect([undefined, 'T', 'P', 'R', 'RF', 'FP']).toContain(p.variant);
    }
  });

  it('matches values read directly off the printed page', () => {
    // Saturday to New York, T trip printed 6:37 ... 7:39 AM.
    const sat = ds.trips.find((t) => t.serviceId === 'SAT' && patternOf(t.patternId).variant === 'T' && t.times[0] === (6 * 60 + 37) * 60 && patternOf(t.patternId).directionId === 0)!;
    expect(sat.times.map((x) => (x - sat.times[0]!) / 60)).toEqual([0, 4, 8, 14, 16, 21, 28, 32, 41, 62]);
    // Weekday to Westwood, T trip leaving PABT 11:05 PM, last printed 12:01 AM (after midnight, 24:01).
    const late = ds.trips.find((t) => t.serviceId === 'WKDY' && patternOf(t.patternId).variant === 'T' && patternOf(t.patternId).directionId === 1 && t.times[0] === 23 * 3600 + 5 * 60)!;
    expect(late.times.at(-1)).toBe(24 * 3600 + 60);
    // Weekday to Westwood, first printed row: 5:19 AM at Weehawken (no PABT time).
    const first = ds.trips.filter((t) => t.serviceId === 'WKDY' && patternOf(t.patternId).directionId === 1)[0]!;
    expect(first.times[0]).toBe((5 * 60 + 19) * 3600 / 60);
    expect(patternOf(first.patternId).stopIds[0]).toBe('W2');
  });

  it('lists departures from Port Authority on a weekday, with the after-midnight trip on the next calendar day', () => {
    const wed = departuresOn(ds, { stopId: 'PABT', date: '20261104', directionId: 1 });
    expect(wed.length).toBeGreaterThan(60);
    expect(wed.some((d) => fmt(d.departs) === '11:05 PM' && d.route.shortName === '165T')).toBe(true);
    const thu = departuresOn(ds, { stopId: 'PABT', date: '20261105', directionId: 1 });
    // Service-day Wednesday trips past 24:00 appear early on Thursday's calendar date.
    expect(thu.some((d) => d.serviceDate === '20261104' && /^12:/.test(fmt(d.departs)))).toBe(true);
  });

  it('keeps Sunday free of express trips (Saturday night trips running past midnight excepted)', () => {
    const sun = departuresOn(ds, { stopId: 'PABT', date: '20261108' });
    expect(sun.length).toBeGreaterThan(20);
    const own = sun.filter((d) => d.serviceDate === '20261108');
    expect(own.length).toBeGreaterThan(20);
    expect(own.every((d) => d.route.shortName === '165' && d.pattern.variant === undefined)).toBe(true);
    expect(sun.every((d) => d.serviceDate === '20261108' || d.serviceDate === '20261107')).toBe(true);
  });
});

describe('twin stops without coordinates', () => {
  it('sends a rider on the wrong side to the stop across the street, and says nothing about distance', () => {
    const c = checkDirection(ds, 'W19', 'PABT');
    expect(c).toMatchObject({ ok: false, reason: 'wrong-side', useStop: { id: 'N19' } });
    expect((c as { distanceM?: number }).distanceM).toBeUndefined();
    expect(checkDirection(ds, 'N19', 'PABT')).toEqual({ ok: true });
  });
  it('picks the return stop from the twin link, and refuses to guess where no twin is printed', () => {
    expect(alightingStopFor(ds, 'PABT', 'N19')?.id).toBe('W19');
    // Fairview: the printed locations differ by direction, so no twin is claimed.
    expect(ds.stops.find((s) => s.id === 'N6')?.twin).toBeUndefined();
    expect(checkDirection(ds, 'W6', 'PABT')).toEqual({ ok: false, reason: 'not-served' });
  });
  it('offers every stop a bus from here reaches, then the wrong side, never short trips the other way', () => {
    const N = (refs: number[]) => refs.map((r) => `N${r}`);
    expect(destinationsFrom(ds, 'N19').map((s) => s.id)).toEqual(['PABT', ...N([18, 17, 16, 15, 14, 13, 12, 11, 10, 8, 7, 6, 5, 4, 3]), 'W20']);
    expect(destinationsFrom(ds, 'W19').map((s) => s.id)).toEqual(['W20', 'PABT', ...N([18, 17, 16, 15, 14, 13, 12, 11, 10, 8, 7, 6, 5, 4, 3])]);
    // From Port Authority every Westwood-bound stop is offered (Hackensack, River Edge...), not just trip ends.
    expect(destinationsFrom(ds, 'PABT').map((s) => s.id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((r) => `W${r}`));
    expect(destinationsFrom(ds, 'W18').map((s) => s.id)).toEqual(['W19', 'W20']);
  });
  it('reverses a commute to an in-between stop by boarding across the street, and says so when nothing goes back', () => {
    expect(returnLeg(ds, 'N19', 'PABT')).toEqual({ fromStopId: 'PABT', toStopId: 'W19' });
    expect(returnLeg(ds, 'N19', 'N11')).toEqual({ fromStopId: 'W11', toStopId: 'W19' }); // Hackensack (Sears), across Main St.
    expect(returnLeg(ds, 'N19', 'N13')).toEqual({ fromStopId: 'W13', toStopId: 'W19' });
    expect(returnLeg(ds, 'N19', 'N10')).toBeUndefined(); // State St. corners differ by direction: no named twin
    expect(returnLeg(demoDataset, 'D2', 'D3')).toEqual({ fromStopId: 'D3B', toStopId: 'D2B' }); // by distance in the demo
  });
  it('finds stops in a town before stops whose direction label names it', () => {
    expect(searchStops(ds, 'westwood').slice(0, 4).map((s) => s.id)).toEqual(['N19', 'W19', 'W20', 'N20']);
    expect(searchStops(ds, 'westwood').map((s) => s.id)).toContain('N20');
  });
  it('links only stops with the same printed location, and links them both ways', () => {
    const byId = new Map(ds.stops.map((s) => [s.id, s]));
    const pairs = ds.stops.filter((s) => s.twin);
    expect(pairs.length).toBe(22);
    for (const s of pairs) {
      expect(byId.get(s.twin!)?.twin).toBe(s.id);
      const strip = (n: string) => n.replace(/ \(to (New York|Westwood)\)$/, '');
      expect(strip(byId.get(s.twin!)!.name)).toBe(strip(s.name));
    }
  });
});

describe('published Port Authority gates', () => {
  const g = ds.publishedGates;
  const at = (service: string, h: number, m: number, day: 'weekday' | 'saturday' | 'sunday') => publishedGateFor(g, service, h * 60 + m, day);
  it('applies the printed local-service windows by clock time, including after midnight', () => {
    expect(at('local', 6, 0, 'weekday')).toMatchObject({ gate: '212', door: '1' });
    expect(at('local', 22, 0, 'sunday')).toMatchObject({ gate: '212', door: '1' });
    expect(at('local', 22, 1, 'weekday')).toMatchObject({ gate: '325' });
    expect(at('local', 24, 30, 'saturday')).toMatchObject({ gate: '325' }); // 12:30 AM after Saturday service
    expect(at('local', 25, 0, 'weekday')).toMatchObject({ gate: '325' }); // 1:00 AM
    expect(at('local', 25, 1, 'weekday')).toMatchObject({ gate: '80' }); // 1:01 AM
    expect(at('local', 5, 59, 'weekday')).toMatchObject({ gate: '80' });
  });
  it('applies the express rules only on the days NJ Transit prints', () => {
    expect(at('P', 17, 0, 'weekday')?.gate).toBe('311');
    expect(at('R', 17, 0, 'weekday')?.gate).toBe('312');
    expect(at('RF', 17, 0, 'weekday')?.gate).toBe('312');
    expect(at('P', 17, 0, 'saturday')).toBeUndefined();
    expect(at('T', 17, 0, 'saturday')?.gate).toBe('310');
    expect(at('T', 23, 0, 'weekday')?.gate).toBe('324');
    expect(at('T', 17, 0, 'sunday')).toBeUndefined();
    expect(at('T', 3, 0, 'weekday')).toBeUndefined();
  });
  it('is a last resort: a posted or learned gate wins, and with no rule the answer stays unknown', () => {
    const posted = [{ tripInstanceId: 'X@20261104', boardingIndex: 0, ageMs: 0, gate: '218', observedAt: 1, source: 'demo' as const }];
    expect(gateFor('X@20261104', 'p', 1020, 'weekday', posted, [], g, 'P')).toMatchObject({ status: 'posted', gate: '218' });
    expect(gateFor('Y@20261104', 'p', 1020, 'weekday', [], [], g, 'P')).toMatchObject({ status: 'published', gate: '311', effective: '20250315' });
    expect(gateFor('Y@20261104', 'p', 1020, 'weekday', [], [], g, 'FP')).toEqual({ status: 'unknown' });
    expect(gateFor('Y@20261104', 'p', 1020, 'weekday', [], [])).toEqual({ status: 'unknown' });
  });
  it('has a published gate rule for every printed Port Authority departure to Westwood', () => {
    const missing: string[] = [];
    for (const t of ds.trips) {
      const p = patternOf(t.patternId);
      if (p.directionId !== 1 || p.stopIds[0] !== 'PABT') continue;
      const day = t.serviceId === 'SAT' ? 'saturday' : t.serviceId === 'SUN' ? 'sunday' : 'weekday';
      if (!publishedGateFor(g, p.variant ?? 'local', t.times[0]! / 60, day)) missing.push(`${t.id} ${p.variant ?? 'local'}`);
    }
    expect(missing).toEqual([]);
  });
});

describe('printed notes', () => {
  it('warns riders getting off at the Park/Ride lot that PM Parkway express trips stop there only on request', () => {
    expect(ds.stops.find((s) => s.id === 'W13')?.noteId).toBe('parkride-request');
    expect(ds.stops.find((s) => s.id === 'N13')?.noteId).toBeUndefined();
    expect(strings.en.stopNotes['parkride-request']).toContain('only if you ask the driver when you board');
  });
  it('has English and Spanish text for every stop note and trip marker the dataset uses', () => {
    for (const lang of ['en', 'es'] as const) {
      for (const s of ds.stops) if (s.noteId) expect(strings[lang].stopNotes[s.noteId], `${lang} ${s.noteId}`).toBeTruthy();
      for (const p of ds.patterns) if (p.variant) expect(strings[lang].variantNotes[p.variant], `${lang} ${p.variant}`).toBeTruthy();
    }
  });
});

describe("NJ Transit's printed holiday list", () => {
  it('lists the printed days for a year, with movable holidays worked out', () => {
    expect(new Set(njtHolidaysIn(2026))).toEqual(new Set([
      '20260101', '20260102', '20260119', '20260216', '20260403', '20260522', '20260525', '20260619', '20260703', '20260704',
      '20260705', '20260904', '20260907', '20261012', '20261111', '20261125', '20261126', '20261127', '20261218', '20261224',
      '20261225', '20261226', '20261231',
    ]));
    // 2027: Good Friday 3/26, Friday before July 4 (a Sunday) is 7/2, Thanksgiving 11/25, Friday before Christmas 12/24.
    for (const d of ['20270326', '20270702', '20271124', '20271125', '20271126', '20271224', '20270118', '20270215', '20270528', '20271011'])
      expect(isNjtHoliday(d), d).toBe(true);
  });
  it('leaves ordinary days alone', () => {
    for (const d of ['20261104', '20261110', '20261124', '20261128', '20270104', '20270701']) expect(isNjtHoliday(d), d).toBe(false);
  });
});

describe("NJ Transit's printed fares and fare zones", () => {
  const quote = (a: string, b: string) => fareBetween(ds, 'R165', a, b);

  it('gives every stop a zone band that never falls moving away from New York', () => {
    const z = ds.publishedFares!.stopZones;
    expect(Object.keys(z).sort()).toEqual(ds.stops.map((s) => s.id).sort());
    for (const p of ds.patterns) {
      const bands = p.stopIds.map((id) => z[id]!);
      const outward = p.directionId === 1 ? bands : [...bands].reverse();
      for (let i = 1; i < outward.length; i++) expect(outward[i]![0], p.id).toBeGreaterThanOrEqual(outward[i - 1]![0]);
    }
  });

  it('charges the printed to/from New York fare for 5 zones between Port Authority and Westwood, both ways', () => {
    expect(quote('PABT', 'W20')).toEqual({ zones: { min: 5, max: 5 }, newYork: true, adult: { min: 845, max: 845 }, reduced: { min: 385, max: 385 } });
    expect(quote('N20', 'PABT')).toEqual(quote('PABT', 'W20'));
    expect(quote('PABT', 'W2')?.adult).toEqual({ min: 420, max: 420 }); // Weehawken: across the state line only
  });

  it('uses the within-New Jersey table between New Jersey stops', () => {
    expect(quote('N11', 'N7')).toEqual({ zones: { min: 1, max: 1 }, newYork: false, adult: { min: 190, max: 190 }, reduced: { min: 85, max: 85 } });
    expect(quote('W6', 'W7')?.adult).toEqual({ min: 300, max: 300 }); // Broad Ave. at Fairview Ave. boundary
    expect(quote('W11', 'W20')?.zones).toEqual({ min: 3, max: 3 });
    expect(quote('N20', 'N5')).toMatchObject({ zones: { min: 4, max: 4 }, adult: { min: 455, max: 455 }, reduced: { min: 210, max: 210 } });
  });

  it('gives a range, not a guess, for a stop drawn on a zone boundary', () => {
    expect(quote('N13', 'PABT')).toEqual({ zones: { min: 3, max: 4 }, newYork: true, adult: { min: 545, max: 730 }, reduced: { min: 245, max: 320 } });
    expect(quote('W15', 'W20')?.zones).toEqual({ min: 1, max: 2 });
    expect(quote('N15', 'N12')?.zones).toEqual({ min: 2, max: 2 }); // to New York, 15 is at Church St., inside the zone
  });

  it('has a printed price for every boarding and alighting pair on every trip pattern', () => {
    for (const p of ds.patterns)
      for (let i = 0; i < p.stopIds.length; i++)
        for (let j = i + 1; j < p.stopIds.length; j++) expect(quote(p.stopIds[i]!, p.stopIds[j]!), `${p.id} ${i}-${j}`).toBeDefined();
  });

  it('shows no fare without a fare table', () => {
    expect(demoDataset.publishedFares).toBeUndefined();
    const [a, b] = demoDataset.stops;
    expect(fareBetween(demoDataset, demoDataset.routes[0]!.id, a!.id, b!.id)).toBeUndefined();
  });
});

describe('first-ride guide', () => {
  it('has the same sections and steps in English and Spanish, and names its sources', () => {
    const { en, es } = strings;
    expect(en.guide.sections.length).toBeGreaterThan(0);
    expect(es.guide.sections.map((s) => s.steps.length)).toEqual(en.guide.sections.map((s) => s.steps.length));
    for (const g of [en.guide, es.guide]) {
      for (const s of g.sections) for (const x of s.steps) expect(x.trim().length, s.title).toBeGreaterThan(20);
      expect(g.sources).toContain('njtransit.com');
      expect(g.sources).toContain('165');
    }
  });
});

describe('clock changes (DST) with printed wall-clock times', () => {
  // Printed times are wall-clock times. Each trip starts at its printed time on the clock and keeps its
  // printed running times, so a bus running through the fall-back night is never shown later than it is.
  const nights = { SAT: ['20261031', '20270313'], SUN: ['20261101', '20270314'], WKDY: ['20261030', '20270312'] } as Record<string, string[]>;
  const printed = (secs: number) => {
    const h = Math.floor((secs % 86400) / 3600);
    return `${h % 12 || 12}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };

  it('starts every trip at its printed time and keeps the printed running times on the nights the clocks change', () => {
    expect(timeBaseOf(ds)).toBe('wall');
    let checked = 0;
    for (const trip of ds.trips)
      for (const date of nights[trip.serviceId] ?? []) {
        const at = trip.times.map((_, i) => tripTimeAt(ds, trip, date, i));
        expect(fmt(at[0]!), `${trip.id} on ${date}`).toBe(printed(trip.times[0]!));
        for (let i = 1; i < at.length; i++) expect(at[i]! - at[0]!, `${trip.id} on ${date} stop ${i}`).toBe((trip.times[i]! - trip.times[0]!) * 1000);
        checked += at.length;
      }
    expect(checked).toBeGreaterThan(1000);
  });

  it('shows the one trip that runs into the changed hour on the safe side', () => {
    const trip = ds.trips.find((t) => t.id === 'WL6-SAT-2510')!;
    const shown = (date: string) => trip.times.map((_, i) => fmt(tripTimeAt(ds, trip, date, i)));
    // Fall back: the bus leaves at 1:10 AM and runs on; printed 2:03 and 2:08 AM come an hour earlier on the clock.
    expect(shown('20261031').slice(-3)).toEqual(['1:57 AM', '1:03 AM', '1:08 AM']);
    // Spring forward: 2:03 AM does not exist; the bus gets there at 3:03 AM.
    expect(shown('20270313').slice(-3)).toEqual(['1:57 AM', '3:03 AM', '3:08 AM']);
    // An ordinary Saturday night reads exactly as printed.
    expect(shown('20261107').slice(-3)).toEqual(['1:57 AM', '2:03 AM', '2:08 AM']);
  });
});

describe('stops near me on the printed timetable', () => {
  it('is not offered: the printed stops have no coordinates', async () => {
    const { nearbyStops, hasStopLocations } = await import('../../src/domain/direction');
    expect(hasStopLocations(ds)).toBe(false);
    expect(nearbyStops(ds, { lat: 40.99, lon: -74.03 }, 5_000)).toEqual([]);
  });
});

describe('"Get me the fuck home" rescue search (issue #32)', () => {
  it('lists every scheduled way home in the data, soonest arrival first, within the horizon', async () => {
    const { rescueOptions, RESCUE_HORIZON_MS } = await import('../../src/domain/rescue');
    const { zonedWallTime } = await import('../../src/domain/time');
    const now = zonedWallTime(2026, 11, 4, 18, 0, TZ);
    const r = rescueOptions(ds, 'PABT', 'W19', now, 'R165');
    expect(r.routesSearched).toEqual(['165', '165T']);
    expect(r.limitations).toEqual(expect.arrayContaining(['schedule_only', 'routes_in_data_only', 'no_walking_or_transfers', 'printed_timepoints_only']));
    const soon = r.options.filter((o) => !o.lastOnLine || o.dep.departs <= r.searchedUntil);
    expect(soon.length).toBeGreaterThan(2);
    for (let i = 1; i < soon.length; i++) expect(soon[i]!.arrives).toBeGreaterThanOrEqual(soon[i - 1]!.arrives);
    for (const o of r.options) {
      expect(o.dep.departs).toBeGreaterThanOrEqual(now - 60_000);
      expect(['W19', 'N19']).toContain(o.alightStopId);
      expect(o.dep.pattern.stopIds.indexOf(o.alightStopId)).toBeGreaterThan(o.dep.stopIndex);
    }
    expect(soon.every((o) => o.dep.departs <= now + RESCUE_HORIZON_MS)).toBe(true);
    // Independently: every departure from Port Authority reaching Irvington St. within the horizon is listed (up to the limit).
    const expected = departuresOn(ds, { stopId: 'PABT', toStopId: 'W19', date: '20261104' }).filter((d) => d.departs >= now - 60_000 && d.departs <= r.searchedUntil);
    expect(soon.length).toBe(Math.min(6, expected.length));
  });

  it('keeps the last trip tonight on the rider’s line, after midnight included', async () => {
    const { rescueOptions } = await import('../../src/domain/rescue');
    const { zonedWallTime } = await import('../../src/domain/time');
    const now = zonedWallTime(2026, 11, 4, 22, 0, TZ);
    const r = rescueOptions(ds, 'PABT', 'W19', now, 'R165');
    const last = r.options.filter((o) => o.lastOnLine);
    expect(last).toHaveLength(1);
    // Independently: the latest 165 departure from Port Authority reaching Irvington St. before 4 AM.
    const end = zonedWallTime(2026, 11, 5, 4, 0, TZ);
    const all = [...departuresOn(ds, { stopId: 'PABT', toStopId: 'W19', date: '20261104' }), ...departuresOn(ds, { stopId: 'PABT', toStopId: 'W19', date: '20261105' })]
      .filter((d) => d.route.id === 'R165' && d.departs >= now - 60_000 && d.departs < end);
    expect(last[0]!.dep.departs).toBe(Math.max(...all.map((d) => d.departs)));
  });

  it('tags the right "last tonight" after midnight, and nothing once tonight’s last bus has gone', async () => {
    const { rescueOptions } = await import('../../src/domain/rescue');
    const { zonedWallTime, localYmd } = await import('../../src/domain/time');
    const tagged = (y: number, m: number, d: number, h: number, min: number, from = 'PABT', to = 'W19') =>
      rescueOptions(ds, from, to, zonedWallTime(y, m, d, h, min, TZ), 'R165').options.filter((o) => o.lastOnLine);
    // Thu 12:30 AM: tonight's last 165 is the 1:10 AM that night, not Friday's.
    const at1230 = tagged(2026, 11, 5, 0, 30);
    expect(at1230).toHaveLength(1);
    expect(localYmd(at1230[0]!.dep.departs, TZ)).toBe('20261105');
    expect(fmt(at1230[0]!.dep.departs)).toBe('1:10 AM');
    // Thu 1:30 AM and Sat 1:30 AM: tonight's last bus has gone; nothing from a later night is tagged.
    expect(tagged(2026, 11, 5, 1, 30)).toEqual([]);
    expect(tagged(2026, 11, 7, 1, 30)).toEqual([]);
    // Inbound at 6 PM: the last evening trip to Port Authority, never the first trip of the next day.
    const inbound = tagged(2026, 11, 4, 18, 0, 'N19', 'PABT');
    expect(inbound).toHaveLength(1);
    expect(localYmd(inbound[0]!.dep.departs, TZ)).toBe('20261104');
    expect(new Date(inbound[0]!.dep.departs).getTime()).toBeLessThan(zonedWallTime(2026, 11, 5, 0, 0, TZ));
  });

  it('only calls a break the overnight one when it spans 3 AM', async () => {
    const { rescueOptions } = await import('../../src/domain/rescue');
    const { zonedWallTime } = await import('../../src/domain/time');
    // A synthetic sparse line from the demo stops: Sunday 8:15 PM, 10:30 PM, then 6:00 AM Monday.
    const at = (y: number, m: number, d: number, h: number, min: number) => zonedWallTime(y, m, d, h, min, TZ);
    const base = demoDataset;
    const mk = (id: string, t: number) => ({ id, patternId: 'L0', serviceId: 'ALL', times: [t, t + 600, t + 1200, t + 1800, t + 2400] });
    const noon = at(2026, 11, 8, 12, 0) - 12 * 3600_000; // service-day origin (GTFS noon minus 12 h)
    const secs = (instant: number) => Math.round((instant - noon) / 1000);
    const sparse: Dataset = { ...base, trips: [mk('a', secs(at(2026, 11, 8, 20, 15))), mk('b', secs(at(2026, 11, 8, 22, 30))), mk('c', secs(at(2026, 11, 9, 6, 0)))],
      calendars: { ALL: { days: [true, true, true, true, true, true, true], start: '20260101', end: '20271231', added: [], removed: [] } } };
    const last = rescueOptions(sparse, 'D1', 'PABT', at(2026, 11, 8, 19, 0), 'R165').options.filter((o) => o.lastOnLine);
    expect(last.map((o) => o.dep.tripId)).toEqual(['b']); // not the 8:15 PM trip before a 2 h 15 min evening gap
    // An early first trip at 3:45 AM followed by a gap is not "last tonight" seen from just after midnight.
    const early: Dataset = { ...sparse, trips: [mk('d', secs(at(2026, 11, 9, 3, 45))), mk('e', secs(at(2026, 11, 9, 6, 0))), mk('f', secs(at(2026, 11, 9, 6, 30)))] };
    expect(rescueOptions(early, 'D1', 'PABT', at(2026, 11, 9, 0, 15), 'R165').options.filter((o) => o.lastOnLine)).toEqual([]);
  });

  it('marks the last trip unconfirmed on a printed holiday', async () => {
    const { rescueOptions } = await import('../../src/domain/rescue');
    const { zonedWallTime } = await import('../../src/domain/time');
    const last = rescueOptions(ds, 'PABT', 'W19', zonedWallTime(2026, 11, 26, 20, 0, TZ), 'R165').options.filter((o) => o.lastOnLine);
    expect(last).toHaveLength(1);
    expect(last[0]!.lastUnconfirmed).toBe(true);
  });

  it('boards across the street when the rider is on the wrong side, and finds nothing from an unknown stop', async () => {
    const { rescueOptions } = await import('../../src/domain/rescue');
    const { zonedWallTime } = await import('../../src/domain/time');
    const now = zonedWallTime(2026, 11, 4, 7, 30, TZ);
    const r = rescueOptions(ds, 'W19', 'PABT', now);
    expect(r.options.length).toBeGreaterThan(0);
    expect(r.options.every((o) => o.boardStopId === 'N19' && o.acrossFromBoard)).toBe(true);
    expect(rescueOptions(ds, 'NOPE', 'PABT', now).options).toEqual([]);
  });
});

describe('rescue wording', () => {
  it('uses "la" for one o’clock and "las" otherwise in Spanish', () => {
    const es = strings.es.rescue;
    expect(es.scheduleOnly('1:30 AM', false)).toContain('hasta la 1:30 AM.');
    expect(es.scheduleOnly('5:30 PM', true)).toContain('hasta las 5:30 PM, más el último que aparece en tu línea.');
    expect(es.arrives('1:10 AM', 'X')).toBe('llega a la 1:10 AM a X');
    expect(es.arrives('~11:05 PM', 'X')).toBe('llega a las ~11:05 PM a X');
    expect(strings.en.rescue.scheduleOnly('5:30 PM', false)).not.toContain('last trip');
    expect(es.scheduleOnly('11:33 a.m.', false)).toContain('hasta las 11:33 a.m. Solo');
    expect(strings.en.rescue.scheduleOnly('5:30 PM', true)).toContain(', plus the last trip listed on your line.');
  });
  it('reads the local hour correctly on a clock-change night', async () => {
    const { localHour, zonedWallTime } = await import('../../src/domain/time');
    expect(localHour(zonedWallTime(2026, 11, 1, 3, 0, TZ), TZ)).toBe(3);
    expect(localHour(zonedWallTime(2027, 3, 14, 3, 30, TZ), TZ)).toBe(3);
    expect(localHour(zonedWallTime(2026, 11, 4, 0, 15, TZ), TZ)).toBe(0);
  });
});


describe('Spanish times use "la 1" and "las 2"', () => {
  it('in Bus Lock and ride mode as well as the rescue screen', () => {
    const es = strings.es;
    expect(es.busLock.waitSince('1:05 a.m.')).toBe('Esperando desde la 1:05 a.m.');
    expect(es.busLock.waitSince('7:50 a.m.')).toBe('Esperando desde las 7:50 a.m.');
    expect(es.busLock.coverage('1:05 a.m.', '1:20 a.m.')).toContain('desde la 1:05 a.m.');
    expect(es.ride.fromGps('1:10 a.m.', 5)).toContain('a la 1:10 a.m.');
  });
});
