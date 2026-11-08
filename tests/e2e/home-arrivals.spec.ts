import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { liveDataset, NOW } from '../helpers/liveBus';
import { LIVE_SOURCE } from '../../src/domain/liveBus';
import type { DepartureBatch, DepartureRequest, DepartureReport } from '../../src/domain/liveDepartures';
const API = 'https://dale-live.test.workers.dev';
const favorite = { id: 'home-live', label: 'My commute', fromStopId: '2', toStopId: '3', routeIds: ['10'] };
type Mode = 'boarding-arrival' | 'live' | 'stale' | 'failed' | 'cancelled' | 'boarding-skipped' | 'destination-skipped' | 'gps-only' | 'date-unknown' | 'wrong-query';
function response(queries: DepartureRequest[], mode: Mode, now: number): DepartureBatch {
  const observedAt = mode === 'stale' ? now - 180_000 : now - 20_000;
  const items: DepartureReport[] = queries.map(query => {
    if (query.tripId !== 'T1' || query.serviceDate !== '20261104') return { query };
    const common = { query: mode === 'wrong-query' ? { ...query, serviceDate: '20261105' } : query, updatedAt: observedAt };
    if (mode === 'cancelled') return { ...common, cancelledAt: observedAt };
    if (mode === 'boarding-skipped') return { ...common, boardingSkipped: true };
    if (mode === 'destination-skipped') return { ...common, destinationSkipped: true };
    if (mode === 'boarding-arrival') return { ...common, boardingArrival: { stopIndex: query.stopIndex, at: now + 300_000, observedAt, kind: 'arrival' } };
    if (mode === 'gps-only') return { ...common, gpsObservedAt: now - 15_000 };
    if (mode === 'date-unknown') return { ...common, problem: 'date-unknown' };
    return { ...common, departure: { stopIndex: query.stopIndex, at: now + 300_000, observedAt, kind: 'departure' }, arrival: { stopIndex: query.toStopIndex, at: now + 2400_000, observedAt, kind: 'arrival' } };
  });
  return { v: 1, source: LIVE_SOURCE, feedVersion: liveDataset.meta.feedVersion, receivedAt: now, vehicles: { state: 'ok', timestamp: now - 10_000 }, updates: { state: mode === 'stale' ? 'stale' : 'ok', timestamp: observedAt }, items };
}
async function setup(page: Page, options: { lang?: 'en' | 'es'; now?: number; pinned?: boolean; wallTime?: number } = {}) {
  const state = { mode: 'live' as Mode, now: options.now ?? NOW, calls: 0, trackerCalls: 0 };
  await page.clock.install({ time: options.wallTime ?? state.now });
  await page.addInitScript(({ favorite, lang }) => {
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([favorite]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light', count: 3 }));
  }, { favorite, lang: options.lang ?? 'en' });
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: liveDataset, headers: { 'access-control-allow-origin': '*' } }));
  await page.route(API + '/v1/departures?**', r => {
    state.calls++;
    if (state.mode === 'failed') return r.abort('failed');
    const queries = JSON.parse(new URL(r.request().url()).searchParams.get('q')!) as DepartureRequest[];
    return r.fulfill({ json: response(queries, state.mode, state.now), headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route(API + '/v1/live?**', r => { state.trackerCalls++; return r.abort('failed'); });
  await page.goto('/?live=1' + (options.pinned ? '&now=2026-11-04T07:20' : ''));
  // Finish loading the schedule before advancing its timeout clock.
  await expect(page.locator('.deps .badge-live').first()).toBeVisible();
  return state;
}
const current = (page: Page) => page.locator('.deps li[data-trip-instance="T1@20261104"]');

test('normal upcoming home shows official estimates automatically, retaining schedule and exact departure on open', async ({ page }) => {
  const state = await setup(page), row = current(page);
  await expect(row.locator('.badge-live')).toHaveText('LIVE ESTIMATE');
  await expect(row.locator('.dep-time')).toHaveText('7:25 AM');
  await expect(row.locator('.dep-original')).toContainText('7:20 AM');
  await expect(row.locator('.destination-clock .dep-place')).toHaveText('Port Authority');
  await expect(row.locator('.dep-arrival-time')).toHaveText('8:00 AM');
  await expect(row.locator('.destination-clock .badge-destination-live')).toHaveText('LIVE ESTIMATE');
  await expect(row.locator('.dep-evidence')).toContainText('NJ Transit · reported 20s ago');
  expect(state.trackerCalls).toBe(0); expect(state.calls).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('arriba.lock.v1.g2'))).toBeNull();
  await row.getByRole('button').click();
  await expect(page.getByRole('button', { name: 'Lock onto this bus', exact: true })).toBeVisible();
  expect(state.trackerCalls).toBe(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toEqual([favorite]);
});

test('an officially delayed bus remains upcoming after its scheduled time, with its original identity', async ({ page }) => {
  await setup(page, { now: NOW + 300_000 });
  await expect(current(page).locator('.dep-time')).toHaveText('7:30 AM');
  await expect(current(page).locator('.dep-original')).toContainText('7:20 AM');
  await expect(page.locator('.deps li').first()).toHaveAttribute('data-trip-instance', 'T1@20261104');
});

for (const mode of ['stale', 'failed'] as const) test(`${mode} feed returns the ordinary list to the schedule with the specific reason`, async ({ page }) => {
  const state = await setup(page);
  await expect(current(page).locator('.badge-live')).toBeVisible();
  state.mode = mode; state.now += 31_000;
  await page.clock.fastForward(31_000);
  await expect(current(page).locator('.badge-live')).toHaveCount(0);
  await expect(current(page).locator('.dep-time')).toContainText('7:20 AM');
  await expect(current(page).locator('.dep-evidence')).toContainText(mode === 'stale' ? 'too old' : 'unavailable');
});

for (const [mode, text] of [
  ['cancelled', 'NJ Transit reports this trip cancelled'],
  ['boarding-skipped', 'skip your boarding stop'],
  ['destination-skipped', 'skip your destination stop'],
  ['gps-only', 'Live GPS is available: tap this bus, then Lock onto this bus'],
  ['date-unknown', 'NJ Transit omitted the trip date'],
  ['wrong-query', 'Live arrival feed unavailable'],
] as const) test(`normal home explains ${mode} without inventing a live arrival`, async ({ page }) => {
  const state = await setup(page); state.mode = mode;
  await page.clock.fastForward(31_000);
  await expect(current(page).locator('.badge-live')).toHaveCount(0);
  await expect(current(page).locator('.dep-evidence')).toContainText(text);
  expect(state.trackerCalls).toBe(0);
});

test('Spanish normal arrivals fit320px and pass accessibility without selecting a bus', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 }); await setup(page, { lang: 'es' });
  await expect(current(page).locator('.badge-live')).toHaveText('ESTIMACIÓN EN VIVO');
  await expect(current(page).locator('.dep-evidence')).toContainText('NJ Transit · informado hace');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('normal-home refresh stops in the background and resumes with bounded batches', async ({ page }) => {
  const state = await setup(page); await expect(current(page).locator('.badge-live')).toBeVisible();
  const calls = state.calls, beforeHidden = await current(page).locator('.dep-evidence').textContent();
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  state.now += 90_000; await page.clock.fastForward(90_000); expect(state.calls).toBe(calls);
  expect(await current(page).locator('.dep-evidence').textContent()).toBe(beforeHidden);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(current(page).locator('.badge-live')).toBeVisible(); expect(state.calls).toBeGreaterThan(calls);
  // A foreground event can precede React committing the newly changed departure selectors;
  // that obsolete request is aborted, then exactly one request serves the new selectors.
  expect(state.calls).toBeLessThanOrEqual(calls + 2);
});
for (const offset of [-86400_000, 86400_000]) test(`normal-home reports respect the app’s pinned date despite a wall-clock offset${offset}`, async ({ page }) => {
  await setup(page, { pinned: true, wallTime: NOW + offset });
  await expect(current(page).locator('.badge-live')).toBeVisible(); await expect(current(page).locator('.dep-time')).toHaveText('7:25 AM');
});

test('a street-stop arrival is visible when NJ Transit has no departure estimate', async ({ page }) => {
  const state = await setup(page); state.mode = 'boarding-arrival';
  await page.clock.fastForward(31_000);
  await expect(current(page).locator('.badge-live')).toHaveText('LIVE ARRIVAL');
  await expect(current(page).locator('.dep-time')).toHaveText('7:25 AM');
  await expect(current(page).locator('.destination-clock .badge-sched')).toHaveText('Scheduled only');
  await expect(current(page).locator('.dep-arrival-time')).toHaveCount(0);
});

for (const lang of ['en', 'es'] as const) test(`paired clocks qualify both locations independently and remain side by side at320px (${lang})`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 }); await setup(page, { lang });
  const row = current(page), board = row.locator('.dep-time'), arrival = row.locator('.dep-arrival-time');
  await expect(row.locator('.boarding-clock .dep-place')).toHaveText(lang === 'en' ? 'Your stop' : 'Tu parada');
  await expect(row.locator('.destination-clock .dep-place')).toHaveText('Port Authority');
  await expect(board).toHaveText(lang === 'en' ? '7:25 AM' : '7:25 a.m.'); await expect(arrival).toHaveText(lang === 'en' ? '8:00 AM' : '8:00 a.m.');
  await expect(row.locator('.dep-original')).toContainText(lang === 'en' ? '7:20 AM' : '7:20 a.m.');
  await expect(row.locator('.dep-destination-original')).toContainText(lang === 'en' ? '7:40 AM' : '7:40 a.m.');
  const a = (await board.boundingBox())!, b = (await arrival.boundingBox())!;
  expect(Math.abs(a.y - b.y)).toBeLessThan(2); expect(b.x).toBeGreaterThan(a.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (lang === 'en') await row.screenshot({ path: 'test-results/paired-live-clocks.png' });
});


test('live icons reflect each source, respect reduced motion, and can be paused in Settings', async ({ page }) => {
  const state = await setup(page), row = current(page), icon = row.locator('.boarding-clock .live-symbol');
  await expect(icon).toHaveAttribute('data-live', 'true');
  expect(await icon.evaluate(el => getComputedStyle(el).animationName)).toBe('live-broadcast');
  await page.emulateMedia({ reducedMotion: 'reduce' }); expect(await icon.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('checkbox', { name: 'Animate live indicators' }).uncheck();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  expect(await icon.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  state.mode = 'failed'; state.now += 31000; await page.clock.fastForward(31000);
  await expect(row.locator('.boarding-clock .live-symbol')).toHaveAttribute('data-live', 'false');
  await expect(row.locator('.boarding-clock .badge-sched')).toHaveText('Scheduled only');
  expect(await row.locator('.boarding-clock .live-symbol').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
});
