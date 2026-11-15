import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { liveDataset } from '../helpers/liveBus';
import type { Dataset } from '../../src/domain/types';

const API = 'https://dale-live.test.workers.dev';
const favorite = { id: 'schedule-test', label: 'Fictional commute', fromStopId: '1', toStopId: '3', routeIds: [] };
const next = (version = 'fixture-v2') => {
  const ds = structuredClone(liveDataset); ds.meta.feedVersion = version;
  ds.meta.builtAt = '2026-11-04T11:00:00Z';
  const t = ds.trips.find(t => t.id === 'T1')!;
  t.times = t.times.map(x => x + 180); t.arrivals = t.arrivals?.map(x => x === null ? null : x + 180);
  return ds;
};
async function setup(page: Page, dataset: () => Dataset, lang = 'en', skin = 'clean') {
  await page.addInitScript(({ favorite, lang, skin }) => {
    if (!localStorage.getItem('notice-fixture')) {
      localStorage.setItem('notice-fixture', '1');
      localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([favorite]));
      localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin, theme: 'light', count: 3 }));
    }
  }, { favorite, lang, skin });
  await page.route(API + '/**', async route => {
    if (new URL(route.request().url()).pathname === '/v1/schedule') await route.fulfill({ json: dataset(), headers: { 'access-control-allow-origin': '*' } });
    else await route.abort();
  });
  await page.goto('/?live=1&now=2026-11-04T06:50');
  await expect.poll(() => baseline(page)).toBe(dataset().meta.feedVersion);
}
const baseline = (page: Page) => page.evaluate(async api => (await (await caches.open('dale-commute-changes-v1')).match(api + '/v1/local-commute-changes'))?.json().then(x => x.baseline.meta.feedVersion), API);
const notices = (page: Page) => page.locator('.commute-change');
for (const lang of ['en','es']) {
  test(`${lang}: compare actual saved schedule copies, preserve notice on reload and dismiss permanently`, async ({ page }) => {
    let ds = structuredClone(liveDataset);
    await setup(page, () => ds, lang);
    await expect(notices(page)).toHaveCount(0);
    const original = await page.evaluate(() => localStorage.getItem('arriba.favorites.v1.g2'));
    ds = next(); await page.reload();
    await expect(notices(page)).toHaveCount(1);
    await expect(notices(page)).toContainText(lang === 'en' ? 'November 4, 2026' : '4 de noviembre de 2026');
    await expect(notices(page)).toContainText('NJ Transit');
    await notices(page).getByText(lang === 'en' ? 'What changed' : 'Qué cambió', { exact: true }).click();
    await expect(notices(page)).toContainText('7:03'); await expect(notices(page)).toContainText('7:43');
    await expect(notices(page)).toContainText('fixture-live → fixture-v2');
    await page.reload(); await expect(notices(page)).toHaveCount(1);
    await notices(page).getByRole('button', { name: /Dismiss schedule update|Descartar actualización/ }).focus();
    await page.keyboard.press('Enter'); await expect(notices(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON');
    await page.reload(); await expect.poll(() => baseline(page)).toBe('fixture-v2'); await expect(notices(page)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('arriba.favorites.v1.g2'))).toBe(original);
    expect(await page.evaluate(() => localStorage.getItem('arriba.lock.v1.g2'))).toBeNull();
  });
}

test('later updates retain unread notices; new favorites get no retrospective alert; printed mode stays separate', async ({ page }) => {
  let ds = structuredClone(liveDataset); await setup(page, () => ds);
  ds = next(); await page.reload(); await expect(notices(page)).toHaveCount(1);
  ds = next('fixture-v3'); const trip = ds.trips.find(t => t.id === 'T1')!;
  trip.times = trip.times.map(x => x + 60); trip.arrivals = trip.arrivals?.map(x => x === null ? null : x + 60);
  await page.reload(); await expect(notices(page)).toHaveCount(2);
  await page.evaluate(f => localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ ...f, id: 'new-trip' }])), favorite);
  await page.reload(); await expect.poll(() => baseline(page)).toBe('fixture-v3'); await expect(notices(page)).toHaveCount(0);
  await page.goto('/?printed=1&now=2026-11-04T06:50'); await expect(notices(page)).toHaveCount(0);
});

test('arrival after midnight carries its actual calendar date', async ({ page }) => {
  let ds = structuredClone(liveDataset); await setup(page, () => ds);
  ds = next(); const trip = ds.trips.find(t => t.id === 'T1')!;
  trip.times = [84600,85800,88200]; trip.arrivals = [84600,null,88200];
  await page.reload(); await expect(notices(page)).toHaveCount(1);
  await notices(page).locator('summary').click();
  await expect(notices(page)).toContainText('arrives November 5, 2026 · 12:30 AM');
});

test('non-overlapping calendars show uncertainty, never a cancellation', async ({ page }) => {
  let ds = structuredClone(liveDataset); await setup(page, () => ds);
  ds = next(); ds.calendars.WK!.start = '20270501'; ds.calendars.WK!.end = '20270510'; ds.calendars.HOL!.added = [];
  await page.reload(); await expect(notices(page)).toHaveCount(1);
  await expect(notices(page)).toContainText('could not compare future changes');
  await expect(notices(page)).not.toContainText(/cancelled|removed bus/i);
});

for (const lang of ['en','es']) for (const skin of ['turnpike','parkway','nyc','garden','clean']) {
  test(`${lang}/${skin}: notice fits narrow enlarged text, passes accessibility and supports native keyboard disclosure`, async ({ page }) => {
    let ds = structuredClone(liveDataset); await setup(page, () => ds, lang, skin);
    ds = next(); await page.reload(); await expect(notices(page)).toHaveCount(1);
    await page.setViewportSize({ width: 305, height: 900 });
    await page.addStyleTag({ content: 'html { font-size: 200% !important; } body { font-family: Verdana, sans-serif !important; }' });
    const disclosure = notices(page).locator('summary'); await disclosure.focus(); await page.keyboard.press('Enter');
    await expect(notices(page).locator('details')).toHaveAttribute('open','');
    expect(await notices(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= 305)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('.commute-changes').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(audit.violations).toEqual([]);
    if (process.env.NOTICE_SCREENSHOTS && skin === 'clean') {
      await page.setViewportSize({ width: 390, height: 1100 });
      await page.addStyleTag({ content: 'html { font-size: 100% !important; }' });
      await notices(page).screenshot({ path: `${process.env.NOTICE_SCREENSHOTS}/dale-schedule-notice-${lang}.png` });
    }
  });
}
