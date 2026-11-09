import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { liveDataset, NOW } from '../helpers/liveBus';
import { LIVE_SOURCE, type LiveBusSnapshot } from '../../src/domain/liveBus';
import { distanceM } from '../../src/domain/direction';
import type { DepartureRequest } from '../../src/domain/liveDepartures';
import type { RouteGeometry } from '../../src/domain/routeDistance';
const API = 'https://dale-live.test.workers.dev', SHA = 'b'.repeat(64), VERSION = SHA.slice(0, 12);
const ds = structuredClone(liveDataset); ds.meta.feedVersion = VERSION;
const a = ds.stops.find(s => s.id === '1')!, b = ds.stops.find(s => s.id === '2')!, c = ds.stops.find(s => s.id === '3')!;
const coord = (s: typeof a) => ({ lat: s.lat!, lon: s.lon! });
const ab = distanceM(coord(a), coord(b)), bc = distanceM(coord(b), coord(c));
const geometry: RouteGeometry = { v: 1, feedVersion: VERSION, sourceSHA256: SHA,
  shapes: { test: { points: [[a.lat!, a.lon!, 0], [b.lat!, b.lon!, ab], [c.lat!, c.lon!, ab + bc]] } },
  trips: { T1: { shapeId: 'test', stopIds: ['1', '2', '3'], stopMeters: [0, ab, ab + bc] } } };
const favorite = { id: 'distance-test', label: 'My commute', fromStopId: '2', toStopId: '3', routeIds: ['10'] };
async function setup(page: Page, lang: 'en' | 'es' = 'en', mismatch = false) {
  const state = { now: NOW, geometryCalls: 0, departuresCalls: 0, trackerCalls: 0, failed: false, gpsConflict: false, lat: (a.lat! + b.lat!) / 2, lon: (a.lon! + b.lon!) / 2, observedAt: NOW - 15000 };
  await page.clock.install({ time: NOW });
  await page.addInitScript(({ favorite, lang }) => {
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([favorite]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light', count: 3 }));
  }, { favorite, lang });
  const gps = () => ({ tripInstanceId: 'T1@20261104', vehicleId: 'bus-A', observedAt: state.observedAt, lat: state.lat, lon: state.lon });
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: ds }));
  await page.route(API + '/v1/geometry?**', r => { state.geometryCalls++; return r.fulfill({ json: mismatch ? { ...geometry, feedVersion: 'mismatched' } : geometry }); });
  await page.route(API + '/v1/departures?**', r => {
    state.departuresCalls++; if (state.failed) return r.abort('failed');
    const queries = JSON.parse(new URL(r.request().url()).searchParams.get('q')!) as DepartureRequest[];
    return r.fulfill({ json: { v: 1, source: LIVE_SOURCE, feedVersion: VERSION, receivedAt: state.now,
      vehicles: { state: 'ok', timestamp: state.now - 10000 }, updates: { state: 'ok', timestamp: state.now - 10000 },
      items: queries.map(query => query.tripId === 'T1' && query.serviceDate === '20261104' ? { query, ...(state.gpsConflict ? { gpsProblem: 'ambiguous' } : { gps: gps() }), gpsObservedAt: state.observedAt } : { query }) } });
  });
  await page.route(API + '/v1/live?**', r => {
    state.trackerCalls++; if (state.failed) return r.abort('failed');
    const body: LiveBusSnapshot = { v: 1, source: LIVE_SOURCE, feedVersion: VERSION, tripInstanceId: 'T1@20261104', receivedAt: state.now,
      vehicles: { state: 'ok', timestamp: state.now - 10000 }, updates: { state: 'ok', timestamp: state.now - 10000 }, observations: [gps()], predictions: [], skippedStops: [] };
    return r.fulfill({ json: body });
  });
  await page.goto('/?live=1');
  await expect(page.locator('.deps li[data-trip-instance="T1@20261104"]')).toBeVisible();
  return state;
}
for (const lang of ['en', 'es'] as const) test(`route distance is compact, source-timed and shared across home/waiting/onboard (${lang})`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const state = await setup(page, lang), row = page.locator('.deps li[data-trip-instance="T1@20261104"]');
  const label = row.locator('.route-distance');
  await expect(label).toContainText('≈ 0.4 mi'); await expect(label).toContainText('15s');
  await expect(row.locator('.badge-live')).toHaveCount(0); // GPS is not an arrival prediction.
  expect(state.geometryCalls).toBe(1); expect(state.departuresCalls).toBe(1); expect(state.trackerCalls).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await row.screenshot({ path: `test-results/distance-home-${lang}.png` });
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await row.getByRole('button').click();
  await page.getByRole('button', { name: lang === 'en' ? 'Lock onto this bus' : 'Seguir este autobús', exact: true }).click();
  await expect(page.locator('.bus-lock > .route-distance')).toContainText('≈ 0.4 mi');
  await page.locator('.bus-lock > .route-distance').screenshot({ path: `test-results/distance-waiting-${lang}.png` });
  await page.getByRole('button', { name: lang === 'en' ? 'I’m waiting at this stop' : 'Estoy esperando en esta parada', exact: true }).click();
  await page.getByRole('button', { name: lang === 'en' ? 'Bus arrived' : 'Llegó el autobús', exact: true }).click();
  await page.getByRole('button', { name: lang === 'en' ? 'I boarded' : 'Ya subí', exact: true }).click();
  const ride = page.getByRole('dialog').locator('.route-distance');
  await expect(ride).toContainText(lang === 'en' ? 'to your stop' : 'hasta tu parada');
  await page.getByRole('dialog').screenshot({ path: `test-results/distance-onboard-${lang}.png` });
  const before = await ride.locator('span').first().textContent();
  state.now += 31000; state.observedAt = state.now - 15000; state.lat = (b.lat! + c.lat!) / 2; state.lon = (b.lon! + c.lon!) / 2;
  await page.clock.fastForward(31000); await expect(ride).not.toContainText(before!);
  state.failed = true; await page.clock.fastForward(31000);
  const frozen = await ride.locator('span').first().textContent();
  await expect(ride).toHaveAttribute('data-stale', 'true');
  await page.clock.fastForward(120000); await expect(ride.locator('span').first()).toHaveText(frozen!);
  await expect(page.getByRole('dialog')).toHaveAttribute('data-stage', 'uncertain');
  // Rotated labels can extend past the strip panel; check the actual scrolled/large
  // light-surface view after fresh GPS becomes stale, including its destination label.
  await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
  for (const edge of ['start', 'end']) {
    await page.locator('.ride-full .strip-wrap').evaluate((el, edge) => { el.scrollLeft = edge === 'end' ? el.scrollWidth : 0; }, edge);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  }
  await page.getByRole('dialog').screenshot({ path: `test-results/distance-onboard-stale-${lang}.png` });
  await page.emulateMedia({ forcedColors: 'active' });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.emulateMedia({ forcedColors: 'none' });
  expect(state.geometryCalls).toBe(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toEqual([favorite]);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});
test('missing exact-feed geometry never displays a straight-line or scheduled substitute', async ({ page }) => {
  const state = await setup(page, 'en', true);
  await expect(page.locator('.deps .dep-reason').first()).toBeVisible();
  await expect(page.locator('.route-distance')).toHaveCount(0);
  expect(state.geometryCalls).toBe(1);
});

test('home keeps original distance and source time on missing feed, then rejects new off-route evidence', async ({ page }) => {
  const state = await setup(page), row = page.locator('.deps li[data-trip-instance="T1@20261104"]'), distance = row.locator('.route-distance');
  await expect(distance).toContainText('≈ 0.4 mi');
  const originalAt = await distance.getAttribute('data-observed-at');
  state.failed = true; state.now += 31000; await page.clock.fastForward(31000);
  await expect(distance).toHaveAttribute('data-stale', 'true');
  await expect(distance).toContainText('Last NJT GPS');
  await expect(distance).toContainText('≈ 0.4 mi');
  await expect(distance).toHaveAttribute('data-observed-at', originalAt!);
  // Resume without advancing the source timestamp: a newer receipt is not newer GPS.
  state.failed = false;
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await expect(distance).toHaveAttribute('data-observed-at', originalAt!);
  state.now += 1000; state.observedAt = state.now - 500; state.lat = 0; state.lon = 0;
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await expect(distance).toHaveCount(0);
  expect(state.geometryCalls).toBe(1);
});

for (const skin of ['turnpike', 'parkway', 'garden', 'nyc']) test(`distance inherits readable compact text in ${skin}`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 }); await setup(page);
  await page.evaluate(skin => { document.documentElement.dataset.skin = skin; }, skin);
  const row = page.locator('.deps li[data-trip-instance="T1@20261104"]');
  await expect(row.locator('.route-distance')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).include('.deps').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
  await row.screenshot({ path: `test-results/distance-home-${skin}.png` });
});

test('new ambiguous GPS removes the cached home distance without changing the selected trip', async ({ page }) => {
  const state = await setup(page), row = page.locator('.deps li[data-trip-instance="T1@20261104"]');
  await expect(row.locator('.route-distance')).toBeVisible();
  state.now += 31000; state.gpsConflict = true; await page.clock.fastForward(31000);
  await expect(row.locator('.route-distance')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toEqual([favorite]);
  expect(state.geometryCalls).toBe(1);
});
