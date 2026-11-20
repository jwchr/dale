import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { buildDataset } from '../../scripts/gtfs-lib.mjs';
// @ts-expect-error plain ESM script without type declarations
import { buildRescueSchedule, officialFares, selectRescueRoutes } from '../../scripts/rescue-schedule.mjs';
import { loadRescueSchedule } from '../../src/data/rescueSchedule';
import { rescueOptions } from '../../src/domain/rescue';
import { parseRescueSchedule, RESCUE_SCHEDULE_MAX_BYTES, withRescueSchedule, type RescueSchedule } from '../../src/domain/rescueSchedule';
import { zonedWallTime } from '../../src/domain/time';
import type { Dataset } from '../../src/domain/types';
import { rescueStrings } from '../../src/ui/rescueStrings';
import { createRouter } from '../../worker/service';
import { syntheticGtfs } from '../helpers/syntheticGtfs';

const CORRIDOR = ['163', '164', '165', '165T'];
const corridorOf = (files: Record<string, string>): Dataset => {
  // The same call scripts/prepare-live-worker.mjs makes for the corridor.
  const ds = buildDataset(files, { routeShortNames: CORRIDOR, splitVariants: true, scheduledOnly: false, feedVersion: 'synthetic01', source: 'NJ Transit GTFS BUS G2', builtAt: '2026-11-19T10:00:00Z' });
  ds.meta.realtime = { provider: 'njt-bus-g2' };
  return ds;
};
const plain = syntheticGtfs();
const withFares = syntheticGtfs({ fares: true });
const corridor = corridorOf(plain);
const built = buildRescueSchedule(plain, corridor, { builtAt: '2026-11-19T10:00:00Z' });
const wider = parseRescueSchedule(built.schedule, corridor);
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

describe('route selection by shared stops', () => {
  const corridorRouteIds = corridor.routes.map((r) => r.feedRouteId ?? r.id);
  it('picks the routes that share a non-terminal stop with the corridor, most shared stops first', () => {
    const s = selectRescueRoutes(plain, { corridorRouteIds });
    expect(s.selected.map((r: { shortName: string }) => r.shortName)).toEqual(['167', '168', '166']);
    expect(s.selected.map((r: { sharedStops: number }) => r.sharedStops)).toEqual([29, 13, 12]);
    expect(s.terminalStopsIgnored).toBe(1);
  });
  it('never picks a route that only shares Port Authority or shares nothing, and skips frequency-only routes', () => {
    const s = selectRescueRoutes(plain, { corridorRouteIds });
    const names = [...s.selected, ...s.skipped].map((r: { shortName: string }) => r.shortName);
    expect(names).not.toContain('190');
    expect(names).not.toContain('900');
    expect(s.skipped).toEqual([{ shortName: '777', routeIds: ['777'], sharedStops: 2, reason: 'frequency_based' }]);
  });
  it('can be narrowed to named routes and capped, and says what it left out', () => {
    const narrowed = selectRescueRoutes(plain, { corridorRouteIds, onlyShortNames: ['166', '168'] });
    expect(narrowed.selected.map((r: { shortName: string }) => r.shortName)).toEqual(['168', '166']);
    expect(narrowed.skipped.find((r: { shortName: string }) => r.shortName === '167').reason).toBe('not_in_allow_list');
    const capped = selectRescueRoutes(plain, { corridorRouteIds, maxRoutes: 1 });
    expect(capped.selected.map((r: { shortName: string }) => r.shortName)).toEqual(['167']);
    expect(capped.skipped.filter((r: { reason: string }) => r.reason === 'over_limit').map((r: { shortName: string }) => r.shortName)).toEqual(['168', '166']);
  });
  it('keeps the corridor schedule exactly as before', () => {
    const before = JSON.stringify(corridor);
    expect(JSON.stringify(corridorOf(withFares))).not.toMatch(/zone_?id|stopZones/i);
    expect(JSON.stringify(corridorOf(plain))).toBe(before);
    expect(corridor.routes.map((r) => r.shortName).sort()).toEqual(CORRIDOR);
    expect(corridor.patterns.every((p) => p.id.startsWith('P'))).toBe(true);
  });
});

describe('wider schedule contents', () => {
  it('carries only the chosen routes, with their own pattern ids', () => {
    expect(built.report.state).toBe('ready');
    expect(wider.routes.map((r) => r.shortName).sort()).toEqual(['166', '167', '168']);
    expect(wider.patterns.every((p) => p.id.startsWith('R'))).toBe(true);
    expect(wider.meta.feedVersion).toBe(corridor.meta.feedVersion);
  });
  it('keeps the latitude and longitude of every served stop', () => {
    const served = new Set(wider.patterns.flatMap((p) => p.stopIds));
    expect(wider.stops.map((s) => s.id).sort()).toEqual([...served].sort());
    expect(wider.stops.every((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))).toBe(true);
    expect(built.report.stopsWithLocation).toBe(built.report.stops);
  });
  it('records that fares are absent when the feed has no fare files, and carries no zones', () => {
    expect(wider.officialFares).toEqual({ state: 'absent', missing: ['fare_attributes.txt', 'fare_rules.txt', 'stops.txt zone_id'] });
    expect(wider.stops.some((s) => 'zone_id' in s || 'zoneId' in s)).toBe(false);
    expect('stopZones' in wider.officialFares).toBe(false);
    // Zone ids alone are not fares, and nothing is derived from distance.
    const zonesOnly = officialFares(syntheticGtfs({ zones: true }), { routeIds: new Set(['165']), stopIds: new Set(['S1']) });
    expect(zonesOnly).toEqual({ state: 'absent', missing: ['fare_attributes.txt', 'fare_rules.txt'] });
  });
  it('carries published zones per stop and the fare rules for corridor and chosen routes when the feed has them', () => {
    const f = buildRescueSchedule(withFares, corridorOf(withFares), { builtAt: '2026-11-19T10:00:00Z' }).schedule.officialFares;
    expect(f.state).toBe('present');
    expect(f.stopZones.S0).toBe('1');
    expect(f.stopZones.S30).toBe('5');
    expect(Object.keys(f.stopZones)).not.toContain('Z1');
    expect(f.rules.map((r: { fareId: string; routeId?: string }) => `${r.fareId}:${r.routeId ?? '*'}`)).toEqual(['Z1:*', 'Z2:*', 'NY:165', 'NY:166']);
    expect(f.attributes.map((a: { fareId: string; price: string }) => `${a.fareId}=${a.price}`)).toEqual(['Z1=1.60', 'Z2=2.10', 'NY=4.00']);
    expect(f.stopsWithoutZone).toBe(0);
  });
  it('carries no fares at all when a fare row cannot be read', () => {
    const broken = { ...withFares, 'fare_attributes.txt': withFares['fare_attributes.txt']!.replace('1.60', 'one sixty') };
    expect(officialFares(broken, { routeIds: new Set(['165']), stopIds: new Set(['S1', 'S9']) }).state).toBe('absent');
  });
  it('notes fare files Dale does not read yet', () => {
    expect(officialFares(plain, { routeIds: new Set(), stopIds: new Set(), sourceFileNames: ['fare_products.txt', 'stops.txt'] }))
      .toMatchObject({ state: 'absent', unreadFareFiles: ['fare_products.txt'] });
  });
});

describe('size: the phone first load stays the corridor schedule', () => {
  it('serves the wider routes as a separate file under the size cap', () => {
    const corridorBytes = bytes(corridor), widerBytes = bytes(wider), together = bytes(withRescueSchedule(corridor, wider).ds);
    // Realistic volume: tens of thousands of corridor stop times.
    expect(corridor.trips.reduce((n, t) => n + t.times.length, 0)).toBeGreaterThan(50_000);
    expect(widerBytes).toBeLessThan(RESCUE_SCHEDULE_MAX_BYTES);
    // Folding the wider routes into /v1/schedule would grow every phone's first download by more than a third.
    expect(together / corridorBytes).toBeGreaterThan(1.3);
    expect(built.report.bytes).toBe(widerBytes);
  });
  it('ships no wider file when it would be too large', () => {
    const many = syntheticGtfs({ routes: [
      ...['163', '164', '165', '165T'].map((id) => ({ id, shortName: id, stops: ['S0', 'S1', 'S2', 'S3'], trips: { WK: 1, SA: 0, SU: 0 } })),
      { id: '166', shortName: '166', stops: ['S2', ...Array.from({ length: 40 }, (_, i) => `B${(i % 25) + 1}`).slice(0, 25)], trips: { WK: 4000, SA: 1500, SU: 1500 } },
    ] });
    const r = buildRescueSchedule(many, corridorOf(many), { builtAt: '2026-11-19T10:00:00Z' });
    expect(r.schedule).toBeNull();
    expect(r.report.state).toBe('too_large');
  });
});

describe('Worker serving', () => {
  const env = { FEED: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{}') }) } } as never;
  const base = 'https://dale-live.test.workers.dev';
  it('serves the corridor schedule unchanged and the wider routes only on request, for the same feed version', async () => {
    const router = createRouter(corridor, undefined, built.schedule);
    expect(await (await router.fetch(new Request(`${base}/v1/schedule`), env)).text()).toBe(JSON.stringify(corridor));
    const ok = await router.fetch(new Request(`${base}/v1/schedule?extra=rescue&feedVersion=synthetic01`), env);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('public, max-age=300');
    expect(parseRescueSchedule(await ok.json(), corridor).routes).toHaveLength(3);
    expect((await router.fetch(new Request(`${base}/v1/schedule?extra=rescue&feedVersion=old`), env)).status).toBe(409);
    expect((await router.fetch(new Request(`${base}/v1/schedule?extra=other&feedVersion=synthetic01`), env)).status).toBe(404);
  });
  it('does not serve a missing, oversized or mismatched wider file', async () => {
    for (const raw of [null, { ...built.schedule, meta: { ...built.schedule.meta, feedVersion: 'other' } }, { ...built.schedule, officialFares: { state: 'present' } }]) {
      const response = await createRouter(corridor, undefined, raw).fetch(new Request(`${base}/v1/schedule?extra=rescue&feedVersion=synthetic01`), env);
      expect(response.status).toBe(404);
    }
  });
  it('keeps live trips and history collection corridor-only', async () => {
    const router = createRouter(corridor, undefined, built.schedule);
    const widerTrip = wider.trips[0]!.id;
    expect((await router.fetch(new Request(`${base}/v1/live?trip=${encodeURIComponent(widerTrip)}&date=20261119`), env)).status).toBe(400);
    // The production entry hands only the corridor schedule to the poller and collector.
    const entry = readFileSync(new URL('../../worker/index.ts', import.meta.url), 'utf8');
    expect(entry).toContain('createFeedClass(ds)');
    expect(entry).not.toMatch(/createFeedClass\([^)]*rescue/);
  });
});

describe('checking a wider file against the app schedule', () => {
  const raw = JSON.parse(JSON.stringify(built.schedule));
  it.each([
    ['another feed version', { ...raw, meta: { ...raw.meta, feedVersion: 'x' } }],
    ['no rescue marker (an older Worker answering with the corridor itself)', corridor],
    ['a route the corridor already has', { ...raw, routes: [...raw.routes, { ...corridor.routes[0], id: corridor.routes[0]!.id }] }],
    ['a moved shared stop', { ...raw, stops: raw.stops.map((s: { id: string; lat: number }) => s.id === 'S1' ? { ...s, lat: s.lat + 0.01 } : s) }],
    ['a fare rule without its fare', { ...raw, officialFares: { state: 'present', source: 'x', stopZones: {}, attributes: [], rules: [{ fareId: 'A' }], stopsWithoutZone: 0 } }],
  ])('rejects %s', (_, value) => {
    expect(() => parseRescueSchedule(value, corridor)).toThrow();
  });
});

describe('rescue with and without the wider routes', () => {
  // Weekday 6 PM, riding outbound from S5 to home at S30.
  const now = zonedWallTime(2026, 11, 19, 18, 0, 'America/New_York');
  const usual = corridor.routes.find((r) => r.shortName === '165')!.id;
  it('without them: corridor only, and the reason other routes were not searched', () => {
    const r = rescueOptions(corridor, 'S5', 'S30', now, usual, 6, undefined, { state: 'missing', reason: 'not_offered' });
    expect(r.widerRoutes).toEqual([]);
    expect(r.widerMissing).toBe('not_offered');
    expect(r.limitations).toContain('wider_routes_missing');
    expect(r.options.length).toBeGreaterThan(0);
    expect(r.options.every((o) => !o.wider)).toBe(true);
    expect(r.routesSearched).toEqual(['163', '164', '165', '165T']);
  });
  it('with them: wider routes join the search, marked as scheduled-only wider routes', () => {
    const r = rescueOptions(corridor, 'S5', 'S30', now, usual, 20, undefined, { state: 'ready', schedule: wider });
    expect(r.widerRoutes).toEqual(['166', '167', '168']);
    expect(r.routesSearched).toEqual(['163', '164', '165', '165T', '166', '167', '168']);
    const routes = new Set(r.options.map((o) => o.dep.route.shortName));
    expect(routes.has('168')).toBe(true);
    expect(routes.has('166')).toBe(false); // 166 never reaches S30
    expect(r.options.filter((o) => o.dep.route.shortName === '168').every((o) => o.wider)).toBe(true);
    expect(r.options.filter((o) => o.dep.route.shortName === '165').every((o) => !o.wider)).toBe(true);
    expect(r.limitations).toEqual(expect.arrayContaining(['schedule_only', 'no_transfers', 'walk_straight_line_only']));
    expect(r.limitations).not.toContain('no_walking_or_transfers');
  });
  it('lists a bus that stops near home with a straight-line distance, never as a verified walk', () => {
    const r = rescueOptions(corridor, 'S5', 'S30', now, usual, 6, undefined, { state: 'ready', schedule: wider });
    expect(r.nearHome.length).toBeGreaterThan(0);
    const first = r.nearHome[0]!;
    expect(first.dep.route.shortName).toBe('167');
    expect(first.alightStopId).toBe('N30');
    expect(first.straightLineM).toBeGreaterThan(250);
    expect(first.straightLineM).toBeLessThan(350);
    expect(first.wider).toBe(true);
  });
  it('never claims "no options" silently when the wider routes are missing', () => {
    // Late at night from a stop with no corridor service left in the window.
    const lateNight = zonedWallTime(2026, 11, 19, 23, 58, 'America/New_York');
    const r = rescueOptions(corridor, 'S5', 'S30', lateNight, usual, 6, 60_000, { state: 'missing', reason: 'offline' });
    expect(r.options.filter((o) => !o.lastOnLine && o.dep.departs <= r.searchedUntil)).toEqual([]);
    expect(r.widerMissing).toBe('offline');
    expect(rescueStrings.en.missing[r.widerMissing as 'offline']).toMatch(/not searched/);
  });
  it('printed data keeps its old notes: no walking or transfers', () => {
    const printed = { ...corridor, stops: corridor.stops.map(({ lat: _lat, lon: _lon, ...s }) => s) } as Dataset;
    const r = rescueOptions(printed, 'S5', 'S30', now, usual);
    expect(r.limitations).toContain('no_walking_or_transfers');
    expect(r.nearHome).toEqual([]);
  });
});

describe('loading the wider routes on the phone', () => {
  const api = 'https://dale-live.test.workers.dev';
  const signal = new AbortController().signal;
  const answer = (status: number, body?: unknown) => (async () => new Response(body === undefined ? 'x' : JSON.stringify(body), { status })) as typeof fetch;
  it('loads and checks the wider file for the app schedule version', async () => {
    let asked = '';
    const net = (async (url: string) => { asked = url; return new Response(JSON.stringify(built.schedule)); }) as unknown as typeof fetch;
    const r = await loadRescueSchedule(api, corridor, signal, net);
    expect(r.state).toBe('ready');
    expect(asked).toBe(`${api}/v1/schedule?extra=rescue&feedVersion=synthetic01`);
  });
  it.each([
    ['not_offered', answer(404)],
    ['feed_mismatch', answer(409)],
    ['not_offered', answer(200, corridor)],
    ['offline', (async () => { throw new TypeError('network'); }) as unknown as typeof fetch],
    ['offline', answer(503)],
  ])('says %s instead of showing no other routes', async (reason, net) => {
    expect(await loadRescueSchedule(api, corridor, signal, net)).toEqual({ state: 'missing', reason });
  });
  it('asks nothing for printed or demo data, or without a server', async () => {
    const never = (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch;
    const { realtime: _r, ...meta } = corridor.meta;
    expect(await loadRescueSchedule(api, { ...corridor, meta: { ...meta, transcribed: { issued: '20261101', documentId: 'x' } } }, signal, never)).toEqual({ state: 'missing', reason: 'not_official' });
    expect(await loadRescueSchedule(undefined, corridor, signal, never)).toEqual({ state: 'missing', reason: 'not_configured' });
  });
});

describe('rescue strings', () => {
  it('has every new message in English and Spanish', () => {
    const compare = (en: unknown, es: unknown, path: string) => {
      expect(typeof es, path).toBe(typeof en);
      if (en && typeof en === 'object') {
        expect(Object.keys(es as object).sort(), path).toEqual(Object.keys(en).sort());
        for (const [k, v] of Object.entries(en)) compare(v, (es as Record<string, unknown>)[k], `${path}.${k}`);
      } else if (typeof en === 'string') expect((es as string).trim().length > 0, path).toBe(true);
      else if (typeof en === 'function') expect((es as (...a: unknown[]) => string)('x', 1)).not.toBe((en as (...a: unknown[]) => string)('x', 1));
    };
    compare(rescueStrings.en, rescueStrings.es, 'rescue');
  });
});

// Typed use of the merged dataset stays the corridor's own objects.
it('merging keeps corridor objects as they are', () => {
  const merged = withRescueSchedule(corridor, wider as RescueSchedule).ds;
  expect(merged.routes.slice(0, corridor.routes.length)).toEqual(corridor.routes);
  expect(merged.stops.find((s) => s.id === 'S1')).toBe(corridor.stops.find((s) => s.id === 'S1'));
});
