import { strings } from '../../src/ui/i18n';
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { liveDataset, NOW } from '../helpers/liveBus';
import { LIVE_SOURCE } from '../../src/domain/liveBus';
import type { DepartureBatch, DepartureRequest, DepartureReport } from '../../src/domain/liveDepartures';
const API = 'https://dale-live.test.workers.dev';
const captureCards = process.env.DALE_CAPTURE_VISUALS === '1';
const favorite = { id: 'home-live', label: 'My commute', fromStopId: '2', toStopId: '3', routeIds: ['10'] };
type Mode = 'boarding-arrival' | 'arrival-only-gps' | 'passed-arrival-gps' | 'arrival-only' | 'long-time' | 'live' | 'stale' | 'failed' | 'cancelled' | 'boarding-skipped' | 'destination-skipped' | 'gps-only' | 'date-unknown' | 'wrong-query';
function response(queries: DepartureRequest[], mode: Mode, now: number): DepartureBatch {
  const observedAt = mode === 'stale' ? now - 180_000 : now - 20_000;
  const items: DepartureReport[] = queries.map(query => {
    if (query.tripId !== 'T1' || query.serviceDate !== '20261104') return { query };
    const common = { query: mode === 'wrong-query' ? { ...query, serviceDate: '20261105' } : query, updatedAt: observedAt };
    if (mode === 'cancelled') return { ...common, cancelledAt: observedAt };
    if (mode === 'boarding-skipped') return { ...common, boardingSkipped: true };
    if (mode === 'destination-skipped') return { ...common, destinationSkipped: true };
    if (mode === 'boarding-arrival') return { ...common, boardingArrival: { stopIndex: query.stopIndex, at: now + 300_000, observedAt, kind: 'arrival' } };
    if (mode === 'arrival-only-gps' || mode === 'passed-arrival-gps') return { ...common, gpsObservedAt: now - 15_000, ...(mode === 'passed-arrival-gps' ? { departure: { stopIndex: query.stopIndex, at: now - 60_000, observedAt, kind: 'departure' as const } } : {}), arrival: { stopIndex: query.toStopIndex, at: now + 2400_000, observedAt, kind: 'arrival' } };
    if (mode === 'arrival-only') return { ...common, arrival: { stopIndex: query.toStopIndex, at: now + 2400_000, observedAt, kind: 'arrival' } };
    if (mode === 'gps-only') return { ...common, gpsObservedAt: now - 15_000 };
    if (mode === 'date-unknown') return { ...common, problem: 'date-unknown' };
    const delay = mode === 'long-time' ? 5 * 3600_000 : 0;
    return { ...common, departure: { stopIndex: query.stopIndex, at: now + delay + 300_000, observedAt, kind: 'departure' }, arrival: { stopIndex: query.toStopIndex, at: now + delay + 2400_000, observedAt, kind: 'arrival' } };
  });
  return { v: 1, source: LIVE_SOURCE, feedVersion: liveDataset.meta.feedVersion, receivedAt: now, vehicles: { state: 'ok', timestamp: now - 10_000 }, updates: { state: mode === 'stale' ? 'stale' : 'ok', timestamp: observedAt }, items };
}
async function setup(page: Page, options: { lang?: 'en' | 'es'; now?: number; pinned?: boolean; wallTime?: number; skin?: string } = {}) {
  const state = { mode: 'live' as Mode, now: options.now ?? NOW, calls: 0, trackerCalls: 0 };
  await page.clock.install({ time: options.wallTime ?? state.now });
  await page.addInitScript(({ favorite, lang, skin }) => {
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([favorite]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin, theme: 'light', count: 3 }));
  }, { favorite, lang: options.lang ?? 'en', skin: options.skin ?? 'clean' });
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
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
  await expect(row.locator('.dep-evidence')).toHaveText('Prediction by NJ Transit 20s ago');
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
  ['gps-only', 'GPS available; no current NJ Transit prediction for your boarding stop'],
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
  await expect(current(page).locator('.dep-evidence')).toHaveText('Predicción de NJ Transit hace 20s');
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
  await expect(icon).toHaveCSS('animation-name', 'live-broadcast');
  await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(icon).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('checkbox', { name: 'Animate live indicators' }).uncheck();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(icon).toHaveCSS('animation-name', 'none');
  state.mode = 'failed'; state.now += 31000; await page.clock.fastForward(31000);
  await expect(row.locator('.boarding-clock .live-symbol')).toHaveAttribute('data-live', 'false');
  await expect(row.locator('.boarding-clock .badge-sched')).toHaveText('Scheduled only');
  await expect(row.locator('.boarding-clock .live-symbol')).toHaveCSS('animation-name', 'none');
});


for (const lang of ['en', 'es'] as const) test(`paused live motion survives scheduled-to-live icon replacement after Settings (${lang})`, async ({ page }) => {
  const state = await setup(page, { lang }), t = strings[lang];
  const icon = current(page).locator('.boarding-clock .live-symbol');
  await expect(icon).toHaveAttribute('data-live', 'true');
  await expect(icon).toHaveCSS('animation-name', 'live-broadcast');
  await page.getByRole('button', { name: t.settings, exact: true }).click();
  await page.getByRole('checkbox', { name: t.live.motion }).uncheck();
  await expect(page.locator('html')).toHaveAttribute('data-live-motion', 'off');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.settings.v1')!).liveMotion)).toBe(false);

  // Home remounts in the checking state. Hold its actual response so the scheduled
  // SVG and subsequent live SVG replacement are deterministic, without sleeps.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(API + '/v1/departures?**', async route => {
    state.calls++;
    const queries = JSON.parse(new URL(route.request().url()).searchParams.get('q')!) as DepartureRequest[];
    await gate;
    await route.fulfill({ json: response(queries, 'live', state.now), headers: { 'access-control-allow-origin': '*' } });
  });
  try {
    await page.getByRole('button', { name: t.back, exact: true }).click();
    await expect(icon).toHaveAttribute('data-live', 'false');
    await expect(icon).toHaveCSS('animation-name', 'none');
    const scheduledIcon = (await icon.elementHandle())!;
    release();
    await expect(icon).toHaveAttribute('data-live', 'true');
    expect(await scheduledIcon.evaluate(el => el.isConnected)).toBe(false);
    await test.info().attach('replaced-icon-style', {
      body: JSON.stringify(await scheduledIcon.evaluate(el => ({ connected: el.isConnected, animationName: getComputedStyle(el).animationName }))),
      contentType: 'application/json',
    });
    // Locator assertions reacquire the current SVG if React replaces it during
    // the read. A one-shot evaluate can instead read empty styles off the old SVG.
    await expect(icon).toHaveCSS('animation-name', 'none');
    await expect(current(page).locator('.boarding-clock .badge-live')).toHaveText(t.live.rows.live);
    await page.getByRole('button', { name: t.settings, exact: true }).click();
    await expect(page.getByRole('checkbox', { name: t.live.motion })).not.toBeChecked();
    await page.getByRole('checkbox', { name: t.live.motion }).check();
    await page.getByRole('button', { name: t.back, exact: true }).click();
    await expect(icon).toHaveAttribute('data-live', 'true');
    await expect(icon).toHaveCSS('animation-name', 'live-broadcast');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(icon).toHaveCSS('animation-name', 'none');
  } finally { release(); }
});


for (const skin of ['turnpike', 'parkway', 'nyc', 'garden', 'clean']) {
  for (const lang of ['en', 'es'] as const) test(`compact departure cards retain clocks and controls (${skin}, ${lang})`, async ({ page }) => {
    const state = await setup(page, { lang, skin });
    const row = current(page), button = row.getByRole('button');
    const source = lang === 'en' ? 'Prediction by NJ Transit 20s ago' : 'Predicción de NJ Transit hace 20s';
    await expect(row.locator('.dep-evidence')).toHaveText(source);
    await expect(row.locator('.dep-route .dep-min')).toHaveText(lang === 'en' ? 'In 5 minutes' : 'En 5 minutos');
    for (const [width, scale] of [[390, 100], [305, 100], [320, 130], [320, 200]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
      const geometry = await button.evaluate(button => {
        const rect = (selector: string) => button.querySelector(selector)!.getBoundingClientRect().toJSON();
        const bounds = button.getBoundingClientRect();
        return { bounds: bounds.toJSON(), route: rect('.route-badge'), main: rect('.dep-main'), countdown: rect('.dep-right'), boardingColumn: rect('.boarding-clock'), boarding: rect('.boarding-clock .dep-time'), arrival: rect('.destination-clock .dep-arrival-time'), overflow: button.scrollWidth - button.clientWidth,
          textOutside: [...button.querySelectorAll('*')].some(node => node.getBoundingClientRect().right > bounds.right + 1) };
      });
      if (scale <= 130) expect(geometry.route.right).toBeLessThan(geometry.main.left);
      else expect(geometry.main.top).toBeGreaterThan(geometry.route.bottom);
      expect(geometry.route.height).toBeGreaterThanOrEqual(44);
      expect(geometry.countdown.top).toBeGreaterThanOrEqual(geometry.route.bottom);
      expect(Math.abs((geometry.route.left + geometry.route.right - geometry.countdown.left - geometry.countdown.right) / 2)).toBeLessThan(1);
      if (scale <= 130) expect(geometry.route.top).toBeLessThan(geometry.boarding.bottom);
      expect(geometry.overflow).toBe(0);
      expect(geometry.textOutside).toBe(false);
      if (scale === 100) {
        expect(Math.abs(geometry.boarding.top - geometry.arrival.top)).toBeLessThan(2);
        expect(geometry.arrival.left).toBeGreaterThan(geometry.boarding.left);
      } else expect(geometry.arrival.top).toBeGreaterThan(geometry.boarding.bottom);
      if (captureCards) await row.screenshot({ path: `test-results/departure-${skin}-${lang}-${width}-${scale}.png` });
    }
    state.mode = 'long-time'; state.now += 31000;
    await page.clock.fastForward(31000);
    await page.setViewportSize({ width: 305, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
    await expect(row.locator('.dep-time')).toHaveText(lang === 'en' ? '12:25 PM' : '12:25 p.m.');
    for (const family of ['', 'Verdana']) {
      await page.evaluate(family => { document.body.style.fontFamily = family; }, family);
      const numeric = await row.locator('.dep-time').evaluate(clock => {
        const text = clock.firstChild!;
        const value = text.textContent!, match = /\d{1,2}:\d{2}/.exec(value)!;
        const range = document.createRange(); range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length);
        return { value, fontFamily: getComputedStyle(clock).fontFamily, fontSize: getComputedStyle(clock).fontSize,
          rects: [...range.getClientRects()].filter(line => line.width > 0).map(line => line.toJSON()) };
      });
      expect(numeric.rects.length, JSON.stringify(numeric)).toBe(1);
    }
    await page.evaluate(() => { document.body.style.fontFamily = ''; });
    const badgeLines = await row.locator('.badge-live, .badge-destination-live').evaluateAll(nodes => nodes.map(node => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), lines = new Map<number, string>();
      let text: Node | null;
      while ((text = walker.nextNode())) for (let index = 0; index < (text.textContent?.length ?? 0); index++) {
        const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + 1);
        const y = Math.round(range.getBoundingClientRect().top);
        lines.set(y, (lines.get(y) ?? '') + text.textContent![index]);
      }
      return [...lines.values()].map(line => line.trim()).filter(Boolean);
    }));
    expect(badgeLines.flat().filter(line => /^\p{L}$/u.test(line)), JSON.stringify(badgeLines)).toEqual([]);
    await expect(row.locator('.boarding-clock .badge-live')).toMatchAriaSnapshot(`- strong: ${lang === 'en' ? 'LIVE ESTIMATE' : 'ESTIMACIÓN EN VIVO'}`);
    if (captureCards) await row.screenshot({ path: `test-results/departure-${skin}-${lang}-long-clock.png` });
    await button.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: lang === 'en' ? 'Lock onto this bus' : 'Seguir este autobús', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('arriba.lock.v1.g2'))).toBeNull();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toEqual([favorite]);
  });
}

for (const lang of ['en', 'es'] as const) test(`source age follows the destination-only prediction and never GPS (${lang})`, async ({ page }) => {
  const state = await setup(page, { lang, now: NOW - 300_000 });
  state.mode = 'arrival-only'; state.now += 31000;
  await page.clock.fastForward(31000);
  const row = current(page);
  await expect(row.locator('.boarding-clock .badge-sched')).toHaveText(lang === 'en' ? 'Scheduled only' : 'Solo horario');
  await expect(row.locator('.boarding-clock .scheduled-warning')).toHaveAccessibleName(lang === 'en' ? 'Live estimate unavailable' : 'Estimación en vivo no disponible');
  await expect(row.locator('.destination-clock .badge-destination-live')).toBeVisible();
  await expect(row.locator('.dep-source')).toHaveText(lang === 'en' ? 'Prediction by NJ Transit 20s ago' : 'Predicción de NJ Transit hace 20s');
  state.mode = 'gps-only'; state.now += 31000;
  await page.clock.fastForward(31000);
  await expect(row.locator('.dep-source')).toHaveCount(0);
  await expect(row.locator('.badge-live, .badge-destination-live')).toHaveCount(0);
  await expect(row.locator('.scheduled-warning')).toHaveCount(2);
  await expect(row.locator('.dep-evidence')).toContainText(strings[lang].live.rows.gpsHint);
});


for (const lang of ['en', 'es'] as const) for (const mode of ['arrival-only-gps', 'passed-arrival-gps'] as const) test(`GPS wording qualifies the boarding stop while retaining destination prediction (${lang}, ${mode})`, async ({ page }) => {
  const state = await setup(page, { lang, now: NOW - 300_000 });
  state.mode = mode; state.now += 31_000;
  await page.clock.fastForward(31_000);
  const row = current(page);
  await expect(row).toHaveAttribute('data-arrival-kind', mode === 'passed-arrival-gps' ? 'passed' : 'no-prediction');
  await expect(row.locator('.boarding-clock .badge-sched')).toHaveText(strings[lang].scheduledOnly);
  await expect(row.locator('.boarding-clock .badge-live')).toHaveCount(0);
  await expect(row.locator('.destination-clock .badge-destination-live')).toHaveText(strings[lang].live.rows.live);
  await expect(row.locator('.destination-clock .dep-arrival-time')).toHaveText(lang === 'en' ? '7:55 AM' : '7:55 a.m.');
  await expect(row.locator('.dep-source')).toHaveText(lang === 'en' ? 'Prediction by NJ Transit 20s ago' : 'Predicción de NJ Transit hace 20s');
  await expect(row.locator('.dep-evidence')).toContainText(lang === 'en' ? 'your boarding stop' : 'tu parada de salida');
  await expect(row.locator('.dep-evidence')).not.toContainText(lang === 'en' ? 'GPS location only—no NJ Transit arrival prediction' : 'Solo ubicación GPS; NJ Transit no ha dado una predicción de llegada');
  await expect(row.locator('.dep-evidence')).toContainText(strings[lang].live.rows.gpsHint);
  await row.getByRole('button').click();
  await expect(page.getByRole('button', { name: strings[lang].lockBus, exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('arriba.lock.v1.g2'))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toEqual([favorite]);
  expect(state.trackerCalls).toBe(0);
});


for (const lang of ['en', 'es'] as const) test(`Garden live indicator remains distinct on forest-green panels with a light preference (${lang})`, async ({ page }) => {
  await setup(page, { skin: 'garden', lang });
  const row = current(page);
  await expect(row.locator('.badge-live')).toHaveText(strings[lang].live.rows.live);
  await expect(row.locator('.badge-destination-live')).toHaveText(strings[lang].live.rows.live);
  await expect(row.locator('.dep-source')).toHaveText(strings[lang].live.rows.sourceAge(20));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const colors = await row.evaluate(row => ({
    icon: getComputedStyle(row.querySelector('.live-symbol[data-live="true"]')!).color,
    panel: getComputedStyle(row.querySelector('button.dep')!).backgroundColor,
  }));
  const icon = colors.icon.match(/[\d.]+/g)!.map(Number), panel = colors.panel.match(/[\d.]+/g)!.map(Number);
  // Conservative brightest possible underlay, including the pulse's minimum .65 opacity.
  const alpha = panel[3] ?? 1;
  const background = panel.slice(0, 3).map(channel => channel * alpha + 255 * (1 - alpha));
  const stroke = icon.slice(0, 3).map((channel, i) => channel * .65 + background[i]! * .35);
  const luminance = (rgb: number[]) => rgb.map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, i) => sum + channel * [.2126, .7152, .0722][i]!, 0);
  const contrast = (luminance(stroke) + .05) / (luminance(background) + .05);
  expect(contrast, JSON.stringify({ ...colors, minimumPulseContrast: contrast })).toBeGreaterThanOrEqual(3);
  expect(colors.icon).toBe('rgb(137, 243, 172)');
});
