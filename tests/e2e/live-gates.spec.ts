import { expect, test, type Page } from '@playwright/test';
import { dataset, NOW } from '../helpers/gates';
import { strings } from '../../src/ui/i18n';
const API = 'https://dale-live.test.workers.dev';
test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
async function setup(page: Page, lang: 'en' | 'es', ageMs = 40_000) {
  let calls = 0, fail = false;
  await page.clock.install({ time: NOW });
  await page.addInitScript(({ lang }) => {
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'gate-fixture', label: 'Commute', fromStopId: 'p', toStopId: 'd', routeIds: ['r'] }]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light', count: 3 }));
  }, { lang });
  await page.route(API + '/**', async r => {
    if (r.request().url() === API + '/v1/schedule') return r.fulfill({ json: dataset, headers: { 'access-control-allow-origin': '*' } });
    if (r.request().url() === API + '/v1/gates') {
      calls++;
      if (fail) return r.abort('failed');
      return r.fulfill({ json: { v: 1, schemaVersion: 1, feedVersion: dataset.meta.feedVersion, postings: [{ tripInstanceId: 't@20261126', boardingIndex: 0, gate: '222', door: '3', source: 'njt-departurevision', ageMs }] }, headers: { 'access-control-allow-origin': '*' } });
    }
    return r.abort('failed');
  });
  await page.goto('/?live=1&now=2026-11-26T07:00');
  await expect(page.locator('.dep-gate[data-status="posted"]').first()).toBeVisible();
  return { calls: () => calls, fail: () => { fail = true; } };
}
for (const lang of ['en', 'es'] as const) test(`source and receipt age on home, Gates and trip (${lang})`, async ({ page }, info) => {
  const state = await setup(page, lang), t = strings[lang];
  const row = page.locator('.dep-gate[data-status="posted"]').first();
  await expect(row.locator('.gate-posted')).toHaveText(t.gatePosted('222', '3'));
  await expect(row.locator('.gate-row-source')).toHaveText(`NJ Transit · ${t.gateReceiptAge(40_000)}`);
  // "NJ Transit" never splits across lines, even at 200% text.
  await expect(row.locator('.gate-row-source .nowrap').first()).toHaveCSS('white-space', 'nowrap');
  await page.screenshot({ path: info.outputPath(`home-${lang}.png`), fullPage: true });
  await page.locator('[data-tab="gates"]').click();
  await expect(page.locator('.gate-row .dep-gate[data-status="posted"]').first()).toContainText('NJ Transit');
  await page.screenshot({ path: info.outputPath(`gates-${lang}.png`), fullPage: true });
  await page.locator('.gate-row').first().click();
  await expect(page.locator('.gate-big')).toHaveText(t.gatePosted('222', '3'));
  await expect(page.locator('.gate-source')).toHaveText(`NJ Transit · ${t.gateReceiptAge(40_000)}`);
  await page.screenshot({ path: info.outputPath(`trip-${lang}.png`), fullPage: true });
  await page.addStyleTag({ content: 'html { font-size: 125% !important; }' });
  await page.getByRole('button').first().focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`trip-large-${lang}.png`), fullPage: true });
  expect(state.calls()).toBe(1);
});
for (const skew of [-120_000, 120_000]) test(`expires on the phone despite ${skew} ms clock skew and failed polling`, async ({ page }) => {
  const state = await setup(page, 'en', 119_000); state.fail();
  await page.clock.setSystemTime(NOW + skew);
  // Response time may include a few milliseconds. Check the final safe interval, then cross expiry.
  await expect(page.locator('.dep-gate[data-status="posted"]').first()).toBeVisible();
  await page.clock.runFor(999);
  await expect(page.locator('.dep-gate[data-status="posted"]')).toHaveCount(0);
  await expect(page.locator('.dep-gate').first()).toContainText(strings.en.gateUnknown);
});
for (const lang of ['en', 'es'] as const) test(`over one minute shows the latency notice (${lang})`, async ({ page }) => {
  await setup(page, lang, 60_001);
  await expect(page.locator('.dep-gate[data-status="posted"]').first()).toContainText(strings[lang].gateLatencyNotice);
});
test('hiding clears evidence and resume waits for a successful refetch; no polling on unrelated screens', async ({ page }) => {
  const state = await setup(page, 'en'); state.fail();
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('.dep-gate[data-status="posted"]')).toHaveCount(0);
  const before = state.calls(); await page.clock.runFor(60_000); expect(state.calls()).toBe(before);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => state.calls()).toBe(before + 1);
  await expect(page.locator('.dep-gate[data-status="posted"]')).toHaveCount(0);
  await page.locator('[data-tab="household"]').click();
  const afterSettings = state.calls(); await page.clock.runFor(31_000); expect(state.calls()).toBe(afterSettings);
});

test('demo mode never requests live gates', async ({ page }) => {
  let calls = 0;
  await page.clock.install({ time: NOW });
  await page.route(API + '/**', r => {
    if (r.request().url() === API + '/v1/gates') calls++;
    return r.abort('failed');
  });
  await page.goto('/?live=1&now=2026-11-26T07:00&demo');
  await expect(page.locator('.demo-banner')).toBeVisible();
  await page.clock.runFor(31_000);
  expect(calls).toBe(0);
});
