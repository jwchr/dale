import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { cityDataset } from '../helpers/cityStops';
import { NOW } from '../helpers/liveBus';
import { strings } from '../../src/ui/i18n';
const API = 'https://dale-live.test.workers.dev';
test.use({ serviceWorkers: 'block', viewport: { width: 320, height: 850 } });
async function setup(page: Page, lang: 'en' | 'es', stage: 'city' | 'stop', count: number) {
  const ds = cityDataset(), pattern = ds.patterns.find(p => p.stopIds.includes('2'))!;
  const trip = ds.trips.find(t => t.patternId === pattern.id)!;
  const extras = count - (stage === 'city' ? 3 : 2);
  for (let i = 0; i < extras; i++) {
    const id = `extra-${i}`;
    ds.stops.push({ id, code: `6000${i}`, name: `Extra Street ${i}`, city: stage === 'city' ? `Test City ${i}` : 'Hackensack' });
    ds.patterns.push({ id, routeId: pattern.routeId, directionId: 0, headsign: 'NEW YORK', stopIds: [id, '3'] });
    ds.trips.push({ ...trip, id, patternId: id, times: [trip.times[0]!, trip.times[trip.times.length - 1]!], arrivals: [trip.times[0]!, trip.times[trip.times.length - 1]!] });
  }
  const favorites = [{ id: 'home', fromStopId: '2', toStopId: '3', routeIds: [pattern.routeId], label: 'My trip', leave: { out: { walkMin: 7, cushionMin: 2 } } }];
  await page.clock.install({ time: NOW });
  await page.addInitScript(({ lang, favorites }) => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify(favorites));
  }, { lang, favorites });
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: ds }));
  await page.route(API + '/v1/departures?**', r => r.abort('failed'));
  await page.goto('/?live=1');
  await expect(page.locator('.dep').first()).toBeVisible();
  return { t: strings[lang], favorites };
}
for (const lang of ['en', 'es'] as const) for (const stage of ['city', 'stop'] as const) for (const count of [5, 6]) {
  test(`${stage} search uses unfiltered ${count}-choice threshold (${lang})`, async ({ page }) => {
    const { t, favorites } = await setup(page, lang, stage, count), s = t.cityPicker;
    const home = page.locator('[data-favorite-id="home"]'), picker = page.locator('.commute-picker');
    const trigger = home.locator(`[data-end="from"] .${stage === 'city' ? 'city-control' : 'stop-control'}`);
    await trigger.focus(); await page.keyboard.press('Enter');
    const heading = page.getByRole('heading', { name: `${t.commuteFrom}: ${stage === 'city' ? s.city : s.stop}`, exact: true });
    await expect(heading).toBeFocused();
    const choices = picker.locator(stage === 'city' ? '.city-choice' : '.stop-choice');
    await expect(choices).toHaveCount(count);
    const label = stage === 'city' ? s.searchCity : s.searchStop;
    const search = picker.getByRole('searchbox', { name: label, exact: true });
    if (count === 5) {
      await expect(picker.locator('label')).toHaveCount(0);
      await expect(search).toHaveCount(0);
      await page.keyboard.press('Tab');
      if (stage === 'city') await expect(choices.first()).toBeFocused();
      else await expect(picker.getByRole('button', { name: s.changeCity, exact: true })).toBeFocused();
    } else {
      await expect(search).toBeVisible();
      await search.fill(stage === 'city' ? 'Hackensack' : '30002');
      await expect(choices).toHaveCount(1);
      await expect(search).toBeVisible(); await expect(search).toBeFocused();
      await search.fill('not-a-match');
      await expect(picker.getByRole('status')).toHaveText(s.empty);
      await expect(search).toBeVisible(); await expect(search).toBeFocused();
      await search.fill(stage === 'city' ? 'Hackensack' : '30002');
      await expect(choices).toHaveCount(1);
    }
    // Crossing a city/stage boundary must clear an earlier query, including hidden searches.
    if (stage === 'city') {
      await picker.getByRole('button', { name: /^Hackensack/ }).click();
      await expect(picker.locator('.stop-choice')).toHaveCount(2);
      await expect(picker.getByRole('searchbox')).toHaveCount(0);
      await picker.getByRole('button', { name: s.changeCity, exact: true }).click();
      await expect(picker.locator('.city-choice')).toHaveCount(count);
      if (count === 6) await expect(search).toHaveValue('');
      await picker.getByRole('button', { name: /^Hackensack/ }).click();
    } else {
      await picker.getByRole('button', { name: s.changeCity, exact: true }).click();
      await expect(picker.locator('.city-choice')).toHaveCount(3);
      await expect(picker.getByRole('searchbox')).toHaveCount(0);
      await picker.getByRole('button', { name: /^Hackensack/ }).click();
      await expect(picker.locator('.stop-choice')).toHaveCount(count);
      if (count === 6) await expect(search).toHaveValue('');
    }
    if (stage === 'stop' && count === 6) await picker.getByRole('searchbox').fill('30002');
    const target = picker.locator('.stop-choice').filter({ hasText: t.selection.stopNumber('30002') });
    await target.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: s.review, exact: true })).toBeFocused();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toEqual(favorites);
    await picker.getByRole('button', { name: s.cancel, exact: true }).click();
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toEqual(favorites);
    await trigger.click();
    if (stage === 'city') await picker.getByRole('button', { name: /^Hackensack/ }).click();
    await picker.locator('.stop-choice').filter({ hasText: t.selection.stopNumber('30002') }).click();
    await picker.getByRole('button', { name: t.selection.save, exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toEqual(favorites);
    expect((await new AxeBuilder({ page }).include('.commute-header').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations).toEqual([]);
    await trigger.click();
    await page.locator('.commute-picker').screenshot({ path: `test-results/search-threshold-${stage}-${count}-${lang}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const lang of ['en', 'es'] as const) test(`two destination cities show choices directly without search (${lang})`, async ({ page }) => {
  const { t, favorites } = await setup(page, lang, 'city', 3);
  const home = page.locator('[data-favorite-id="home"]'), picker = page.locator('.commute-picker');
  const trigger = home.locator('[data-end="to"] .city-control');
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: `${t.commuteToLabel}: ${t.cityPicker.city}`, exact: true })).toBeFocused();
  await expect(picker.locator('.city-choice strong')).toHaveText(['Fort Lee', t.commuteNewYork]);
  await expect(picker.locator('label, input')).toHaveCount(0);
  await page.keyboard.press('Tab'); await expect(picker.locator('.city-choice').first()).toBeFocused();
  await picker.getByRole('button', { name: new RegExp('^' + t.commuteNewYork) }).click();
  await expect(picker.locator('.stop-choice')).toHaveCount(1);
  await expect(picker.locator('label, input')).toHaveCount(0);
  await picker.locator('.stop-choice').click();
  await picker.getByRole('button', { name: t.cityPicker.cancel, exact: true }).click();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toEqual(favorites);
});
