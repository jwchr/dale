import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { cityDataset } from '../helpers/cityStops';
import { NOW } from '../helpers/liveBus';
import { strings } from '../../src/ui/i18n';

const API = 'https://dale-live.test.workers.dev';
test.use({ serviceWorkers: 'block' });

async function setup(page: import('@playwright/test').Page, lang: 'en' | 'es', ds = cityDataset(), skin = 'clean') {
  await page.addInitScript(({ lang, skin }) => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin, theme: 'light' }));
  }, { lang, skin });
  await page.clock.install({ time: NOW });
  await page.route(API + '/v1/schedule', route => route.fulfill({ json: ds }));
  await page.route(API + '/v1/departures?**', route => route.abort('failed'));
  await page.route(API + '/v1/geometry?**', route => route.abort('failed'));
  await page.goto('/?live=1&now=2026-11-04T07:20');
  const t = strings[lang];
  await page.getByRole('button', { name: t.findStop, exact: true }).first().click();
  return t;
}

for (const lang of ['en', 'es'] as const) test(`Find a stop starts with towns and keeps direct search (${lang})`, async ({ page }) => {
  const t = await setup(page, lang);
  await expect(page.locator('.find-stop-towns .city-choice')).toHaveCount(3);
  await expect(page.locator('.find-stop-towns .stop-choice')).toHaveCount(0);
  const town = page.locator('.find-stop-towns').getByRole('button', { name: /^Hackensack/ });
  await town.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.locator('.find-stop-towns .stop-choice')).toHaveCount(2);
  await expect(page.locator('.find-stop-towns')).not.toContainText('Bridge Plaza');
  await page.getByRole('searchbox').fill('30005');
  await expect(page.locator('.find-stop-towns .stop-choice')).toHaveCount(1);
  await expect(page.locator('.find-stop-towns .stop-choice')).toContainText(t.selection.stopNumber('30005'));
  await page.getByRole('button', { name: t.cityPicker.changeCity, exact: true }).click();
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await page.getByRole('searchbox').fill('Hackensack');
  await expect(page.locator('.find-stop-towns .city-choice')).toHaveCount(1);
  await page.getByRole('searchbox').fill('30002');
  await expect(page.locator('.find-stop-towns .stop-choice')).toHaveCount(1);
  await expect(page.locator('.find-stop-towns .stop-choice')).toContainText('State Street at Lawrence Street');
  // Choosing a stop preserves the existing destination/confirmation flow and does not save a trip yet.
  const savedBefore = await page.evaluate(() => localStorage.getItem('arriba.favorites.v1.g2'));
  await page.locator('.find-stop-towns .stop-choice').click();
  await expect(page.locator('.trip-selection')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('arriba.favorites.v1.g2'))).toBe(savedBefore);
  const { violations } = await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map(v => v.id)).toEqual([]);
});

test('town browsing includes every boardable stop, including beyond the global-search limit', async ({ page }) => {
  const ds = cityDataset(), outward = ds.patterns.find(p => p.stopIds.includes('2'))!;
  const trip = ds.trips.find(t => t.patternId === outward.id)!;
  for (let i = 0; i < 25; i++) {
    const id = `extra-${i}`;
    ds.stops.push({ id, code: `6000${i}`, name: `Extra Street ${i}`, city: 'Hackensack' });
    ds.patterns.push({ id, routeId: outward.routeId, directionId: outward.directionId, headsign: outward.headsign, stopIds: [id, '3'] });
    ds.trips.push({ ...trip, id, patternId: id, times: [trip.times[0]!, trip.times.at(-1)!], arrivals: [trip.times[0]!, trip.times.at(-1)!] });
  }
  await setup(page, 'en', ds);
  await page.locator('.find-stop-towns').getByRole('button', { name: /^Hackensack/ }).click();
  await expect(page.locator('.find-stop-towns .stop-choice')).toHaveCount(27);
  await page.getByRole('searchbox').fill('600024');
  await expect(page.locator('.find-stop-towns .stop-choice')).toHaveCount(1);
  await expect(page.locator('.find-stop-towns .stop-choice')).toContainText('Extra Street 24');
});

test('unverified city fields stay in the unknown-city group', async ({ page }) => {
  const ds = cityDataset(); delete ds.meta.stopCities;
  ds.stops.forEach(stop => { if (!stop.terminal) stop.city = 'Invented Town'; });
  const t = await setup(page, 'en', ds);
  await expect(page.locator('.find-stop-towns')).not.toContainText('Invented Town');
  await expect(page.locator('.find-stop-towns').getByRole('button', { name: new RegExp('^' + t.selection.unknownCity) })).toBeVisible();
});

for (const skin of ['turnpike', 'parkway', 'nyc', 'garden', 'clean']) for (const lang of ['en', 'es'] as const) {
  test(`town choices fit narrow phones and enlarged text (${skin}, ${lang})`, async ({ page }) => {
    await setup(page, lang, cityDataset(), skin);
    await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
    for (const width of [305, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      for (const button of await page.locator('.find-stop-towns .city-choice').all()) {
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(48);
      }
    }
  });
}
