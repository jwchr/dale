import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { strings } from '../../src/ui/i18n';
import photo from '../fixtures/nyc-night-photo.json' with { type: 'json' };
import { liveDataset, NOW } from '../helpers/liveBus';

const favorites = [{ id: 'night', fromStopId: 'N10', toStopId: 'PABT', routeIds: [], label: 'Night commute' }];
const PHOTO = '**/assets/ramble-night-*.webp';
test.use({ serviceWorkers: 'block', viewport: { width: 320, height: 780 } });
for (const lang of ['en', 'es'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`NYC uses the supplied night photo with readable phone controls and preserved choices (${lang}, ${theme})`, async ({ page }) => {
    const t = strings[lang]; const images = new Set<string>();
    page.on('request', request => { if (/ramble-night-|\/backgrounds\//.test(request.url())) images.add(request.url()); });
    await page.addInitScript(({ lang, theme, favorites }) => {
      Math.random = () => 0;
      localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, theme, skin: 'nyc' }));
      localStorage.setItem('arriba.favorites.v1', JSON.stringify(favorites));
      localStorage.setItem('arriba.penn-guide.v1.bus', JSON.stringify({ mode: 'bus', station: 'essex', direction: 'return', travelling: true, step: 3, walks: { essex: 7 } }));
    }, { lang, theme, favorites });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/?printed=1&now=2026-11-04T07:50');
    await expect(page.locator('.dep').first()).toBeVisible();
    await expect(page.locator('.photo-backdrop')).toHaveAttribute('data-photo', 'ramble-night');
    expect(images.size).toBe(1); expect([...images][0]).toMatch(/\/assets\/ramble-night-[^/]+\.webp$/);
    const original = await page.evaluate(() => ({ settings: localStorage.getItem('arriba.settings.v1'), favorites: localStorage.getItem('arriba.favorites.v1'), bus: localStorage.getItem('arriba.penn-guide.v1.bus'), lock: localStorage.getItem('arriba.lock.v1') }));
    const dimensions = await page.locator('.photo-backdrop').evaluate(async node => {
      const url = getComputedStyle(node).backgroundImage.slice(5, -2); const image = new Image(); image.src = url; await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    });
    expect(dimensions).toEqual({ width: photo.width, height: photo.height });
    for (const width of [305, 320, 390]) for (const scale of [100, 130, 200]) {
      await page.setViewportSize({ width, height: 780 });
      await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator('.highway-name, .dep-clock > span').evaluateAll(nodes => nodes.every(n => n.scrollWidth <= n.clientWidth + 1))).toBe(true);
      await expect(page.getByRole('button', { name: t.settings, exact: true })).toBeVisible();
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; scrollTo(0, 0); });
    await page.setViewportSize({ width: 320, height: 780 });
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `test-results/nyc-night-${lang}-${theme}.png`, fullPage: true });
    await page.screenshot({ path: `test-results/nyc-night-viewport-${lang}-${theme}.png` });
    await page.getByRole('button', { name: t.journey.trainMode, exact: true }).click();
    await expect(page.locator('.photo-backdrop')).toHaveAttribute('data-photo', 'ramble-night');
    await page.getByRole('button', { name: t.journey.busMode, exact: true }).click();
    await page.getByRole('button', { name: t.settings, exact: true }).click();
    for (const skin of ['garden', 'nyc'] as const) {
      const button = page.getByRole('button', { name: t.skins[skin], exact: true }); await button.focus(); await button.press('Enter');
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
      await expect(page.locator('.photo-backdrop')).toHaveAttribute('data-photo', skin === 'nyc' ? 'ramble-night' : 'paterson-great-falls');
    }
    await page.getByRole('button', { name: t.back, exact: true }).click();
    expect(await page.evaluate(() => ({ settings: localStorage.getItem('arriba.settings.v1'), favorites: localStorage.getItem('arriba.favorites.v1'), bus: localStorage.getItem('arriba.penn-guide.v1.bus'), lock: localStorage.getItem('arriba.lock.v1') }))).toEqual(original);
  });
}

test('a failed NYC night asset uses the original skyline without requesting another photograph', async ({ page }) => {
  await page.addInitScript(favorites => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ skin: 'nyc' }));
    localStorage.setItem('arriba.favorites.v1', JSON.stringify(favorites));
  }, favorites);
  const photos = new Set<string>(); page.on('request', r => { if (/ramble-night-|\/backgrounds\//.test(r.url())) photos.add(r.url()); });
  await page.route(PHOTO, r => r.abort('failed'));
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await expect(page.locator('.dep').first()).toBeVisible(); await expect(page.locator('.skin-backdrop svg')).toHaveCount(1);
  await expect(page.locator('.photo-backdrop')).toHaveCount(0); expect(photos.size).toBe(1);
  expect([...photos][0]).toContain('/assets/ramble-night-');
});

for (const preference of ['forced-colors', 'reduced-transparency'] as const) {
  test(`NYC requests no photo under ${preference}`, async ({ page, context }) => {
    await page.addInitScript(favorites => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ skin: 'nyc' }));
    localStorage.setItem('arriba.favorites.v1', JSON.stringify(favorites));
  }, favorites);
    if (preference === 'forced-colors') await page.emulateMedia({ forcedColors: 'active' });
    else {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    }
    const photos: string[] = []; page.on('request', r => { if (/ramble-night-|\/backgrounds\//.test(r.url())) photos.push(r.url()); });
    await page.goto('/?printed=1&now=2026-11-04T07:50');
    await expect(page.locator('.dep').first()).toBeVisible(); await expect(page.locator('.skin-backdrop')).toBeHidden();
    expect(photos).toEqual([]);
  });
}

test('style changes keep fallback art until the matching image is ready and ignore a late prior-style load', async ({ page }) => {
  await page.addInitScript(() => { Math.random = () => 0; localStorage.setItem('arriba.settings.v1', JSON.stringify({ skin: 'nyc' })); });
  let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/backgrounds/*.webp', async route => { await ready; await route.continue(); });
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await expect(page.locator('.photo-backdrop')).toHaveAttribute('data-photo', 'ramble-night');
  await page.getByRole('button', { name: strings.en.settings, exact: true }).click();
  await page.getByRole('button', { name: strings.en.skins.garden, exact: true }).click();
  await expect(page.locator('.skin-backdrop svg')).toHaveCount(1); await expect(page.locator('.photo-backdrop')).toHaveCount(0);
  await page.getByRole('button', { name: strings.en.skins.nyc, exact: true }).click();
  await expect(page.locator('.photo-backdrop')).toHaveAttribute('data-photo', 'ramble-night');
  const priorResponse = page.waitForResponse('**/backgrounds/*.webp'); release(); await (await priorResponse).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('.photo-backdrop')).toHaveAttribute('data-photo', 'ramble-night');
});

test('switching to the night photo preserves an existing exact-bus lock', async ({ page }) => {
  const API = 'https://dale-live.test.workers.dev'; const t = strings.en;
  await page.clock.install({ time: NOW });
  await page.addInitScript(() => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ skin: 'garden' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'first', fromStopId: '2', toStopId: '3', routeIds: [], label: 'My commute' }]));
  });
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: liveDataset }));
  await page.route(API + '/v1/departures?**', r => r.abort('failed')); await page.route(API + '/v1/live?**', r => r.abort('failed'));
  await page.goto('/?live=1'); await page.locator('.dep').first().click();
  await page.getByRole('button', { name: t.lockBus, exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('arriba.lock.v1.g2'))).not.toBeNull();
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.lock.v1.g2')!));
  await page.getByRole('button', { name: t.back, exact: true }).click();
  await page.getByRole('button', { name: t.settings, exact: true }).click();
  await page.getByRole('button', { name: t.skins.nyc, exact: true }).click();
  await expect(page.locator('.photo-backdrop')).toHaveAttribute('data-photo', 'ramble-night');
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.lock.v1.g2')!));
  expect(after.dep).toEqual(before.dep); expect(after.leg).toEqual(before.leg); expect(after.session.id).toBe(before.session.id);
  expect(after.session.lock).toEqual(before.session.lock);
});
