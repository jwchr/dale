import { expect, test, type Page } from '@playwright/test';
import { liveDataset } from '../helpers/liveBus';
import { strings, type Lang } from '../../src/ui/i18n';

test.use({ viewport: { width: 320, height: 740 }, serviceWorkers: 'block' });
const API = 'https://dale-live.test.workers.dev';

async function ride(page: Page, lang: Lang) {
  await page.addInitScript(lang => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light', count: 3 }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'map-test', label: 'Map test', fromStopId: '2', toStopId: '3', routeIds: ['10'] }]));
    // Observe actual GPU draw calls without exposing the map or its data from production code.
    for (const name of ['drawElements', 'drawArrays'] as const) {
      const draw = WebGL2RenderingContext.prototype[name];
      WebGL2RenderingContext.prototype[name] = function (this: WebGL2RenderingContext, ...args: number[]) {
        if (this.canvas instanceof HTMLCanvasElement) this.canvas.dataset.mapDraws = String(Number(this.canvas.dataset.mapDraws ?? 0) + 1);
        return (draw as (...args: number[]) => void).apply(this, args);
      };
    }
  }, lang);
  await page.route(API + '/**', route => route.abort());
  await page.route(API + '/v1/schedule', route => route.fulfill({ json: liveDataset, headers: { 'access-control-allow-origin': '*' } }));
  await page.goto('/?live=1&now=2026-11-04T07:20');
  await page.getByRole('button', { name: /7:20/ }).first().click();
  await page.getByRole('button', { name: lang === 'en' ? 'Lock onto this bus' : 'Seguir este autobús', exact: true }).click();
  const t = strings[lang];
  await page.getByRole('button', { name: t.busLock.begin, exact: true }).click();
  await page.getByRole('button', { name: t.busLock.arrived, exact: true }).click();
  await page.getByRole('button', { name: t.busLock.boarded, exact: true }).click();
  return page.getByRole('dialog');
}

for (const lang of ['en', 'es'] as const) for (const view of ['street', 'transit'] as const) for (const size of ['100%', '200%']) {
  test(`a glyph range HTTP 404 keeps ${view} drawing at 320px and ${size} text in ${lang}`, async ({ page }) => {
    let missingRanges = 0, glyphFallbacks = 0;
    const errors: string[] = [], outside: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      // MapLibre 6 renders a failed glyph range locally and warns instead of firing
      // a map error. Wait for that processing before checking subsequent drawing.
      if (message.type() === 'warning' && message.text().includes('Unable to load glyph range')) glyphFallbacks++;
    });
    page.on('request', request => {
      const host = new URL(request.url()).hostname;
      if (!['localhost', 'dale-live.test.workers.dev'].includes(host)) outside.push(host);
    });
    // A real request used by MapLibre's glyph loader, not a synthetic error event.
    await page.route('**/map/fonts/*/0-255.pbf', route => {
      missingRanges++;
      return route.fulfill({ status: 404, body: '' });
    });
    const dialog = await ride(page, lang), t = strings[lang];
    await page.evaluate(size => { document.documentElement.style.fontSize = size; }, size);
    await dialog.getByRole('button', { name: t.maps[view], exact: true }).click();
    const map = dialog.locator('.route-map'), canvas = map.locator('canvas');
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    await expect(map).toHaveAttribute('data-presentation', view);
    await expect.poll(() => missingRanges, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => glyphFallbacks, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(async () => Number(await map.getAttribute('data-map-errors'))).toBeGreaterThan(0);
    await expect(dialog).not.toContainText(t.progress.mapFailed);
    // Prove a fresh frame is drawn after the failure and the camera still works.
    await canvas.evaluate(c => { c.dataset.mapDraws = '0'; });
    await dialog.getByRole('button', { name: t.maps.route, exact: true }).click();
    await expect(map).toHaveAttribute('data-camera', 'route');
    await expect.poll(async () => Number(await map.getAttribute('data-map-errors'))).toBeGreaterThan(0);
    await expect.poll(async () => Number(await canvas.getAttribute('data-map-draws'))).toBeGreaterThan(0);
    await dialog.getByRole('button', { name: t.maps.close, exact: true }).click();
    await expect(map).toHaveAttribute('data-camera', 'bus');
    await expect(dialog.locator('.led-bar')).toBeVisible();
    await expect(map).toContainText('OpenStreetMap');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await dialog.screenshot({ path: `test-results/map-glyph-404-${view}-${lang}-320-${size}.png` });
    expect(errors).toEqual([]);
    expect(outside).toEqual([]);
  });
}

for (const lang of ['en', 'es'] as const) test(`WebGL context loss still shows the fallback and leaves the ride usable in ${lang}`, async ({ page }) => {
  const dialog = await ride(page, lang), t = strings[lang];
  const canvas = dialog.locator('.route-map canvas');
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await canvas.evaluate(c => c.dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
  await expect(dialog).toContainText(t.progress.mapFailed);
  await expect(dialog.locator('.led-bar')).toBeVisible();
  await dialog.getByRole('button', { name: t.maps.line, exact: true }).click();
  await expect(dialog.locator('.transit-line-map')).toBeVisible();
});
