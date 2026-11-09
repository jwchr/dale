import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { cityDataset } from '../helpers/cityStops';
import { NOW } from '../helpers/liveBus';
import { strings } from '../../src/ui/i18n';
import type { Favorite } from '../../src/domain/favorites';
const API = 'https://dale-live.test.workers.dev';
test.use({ serviceWorkers: 'block' });
async function setup(page: Page, lang: 'en' | 'es', skin = 'clean', from = '2', to = '3', verified = true, unknownCityStop?: string) {
  const ds = cityDataset();
  if (unknownCityStop) delete ds.stops.find(stop => stop.id === unknownCityStop)!.city;
  if (!verified) ds.meta.stopCities!.state = 'unavailable';
  const route = ds.patterns.find(p => p.stopIds.includes('2'))!.routeId;
  const favorites: Favorite[] = [
    { id: 'home', label: 'My trip', fromStopId: from, toStopId: to, routeIds: [route], leave: { out: { walkMin: 7, cushionMin: 2 }, back: { walkMin: 3, cushionMin: 1 } } },
    { id: 'second', label: 'Second trip', fromStopId: '1', toStopId: '3', routeIds: [] },
  ];
  await page.clock.install({ time: NOW });
  await page.addInitScript(({ lang, skin, favorites }) => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin, theme: 'light' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify(favorites));
    localStorage.setItem('arriba.penn-guide.v1.bus', JSON.stringify({ mode: 'bus', station: 'essex', direction: 'return', travelling: true, step: 3, walks: { summit: 8 } }));
  }, { lang, skin, favorites });
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: ds }));
  await page.route(API + '/v1/departures?**', r => r.abort('failed'));
  await page.route(API + '/v1/live?**', r => r.abort('failed'));
  await page.goto('/?live=1');
  await expect(page.locator('[data-favorite-id="home"]')).toBeVisible();
  return { ds, favorites, t: strings[lang] };
}
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!));
for (const skin of ['turnpike', 'parkway', 'nyc', 'garden', 'clean']) for (const lang of ['en', 'es'] as const) {
  test(`city then stop, explicit save/cancel and readable controls (${skin}, ${lang})`, async ({ page }) => {
    const { favorites, t } = await setup(page, lang, skin), s = t.cityPicker;
    const home = page.locator('[data-favorite-id="home"]');
    const city = home.locator('[data-end="from"] .city-control');
    await city.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: `${t.commuteFrom}: ${s.city}`, exact: true })).toBeFocused();
    await expect(page.locator('.city-choice strong')).toHaveText(['Fort Lee', 'Hackensack', t.commuteNewYork]);
    await expect(page.locator('.stop-choice')).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(page.locator('.city-choice').first()).toBeFocused();
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await page.setViewportSize({ width: 305, height: 850 });
    await page.locator('.commute-picker').screenshot({ path: `test-results/city-list-${skin}-${lang}.png` });
    await page.getByRole('button', { name: /^Hackensack/ }).tap();
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await expect(page.locator('.stop-choice')).toHaveCount(2);
    await page.locator('.commute-picker').screenshot({ path: `test-results/city-stops-${skin}-${lang}.png` });
    const chosenStop = page.locator('.stop-choice').filter({ hasText: t.selection.stopNumber('30002') });
    await expect(chosenStop).toContainText('State Street at Lawrence Street');
    await expect(chosenStop).toContainText('165');
    await chosenStop.click();
    await expect(page.getByRole('heading', { name: s.review })).toBeFocused();
    expect(await stored(page)).toEqual(favorites);
    await page.getByRole('button', { name: s.cancel, exact: true }).click();
    await expect(city).toBeFocused();
    expect(await stored(page)).toEqual(favorites);
    await home.locator('[data-end="from"] .stop-control').tap();
    await expect(page.getByRole('heading', { name: `${t.commuteFrom}: ${s.stop}`, exact: true })).toBeVisible();
    await expect(page.locator('.picker-city strong')).toHaveText('Hackensack');
    await page.getByRole('button', { name: s.changeCity, exact: true }).click();
    await page.getByRole('button', { name: /^Fort Lee/ }).click();
    await page.locator('.stop-choice').click();
    await expect(page.getByRole('heading', { name: s.review })).toBeVisible();
    expect(await stored(page)).toEqual(favorites);
    for (const [width, scale] of [[390, 100], [305, 100], [320, 130], [320, 200]] as const) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
      const geometry = await page.locator('.commute-picker').evaluate(card => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        outside: [...card.querySelectorAll('button, dd')].some(node => node.getBoundingClientRect().right > innerWidth),
        saveHeight: card.querySelector('.save-trip')!.getBoundingClientRect().height,
      }));
      expect(geometry).toMatchObject({ overflow: 0, outside: false });
      expect(geometry.saveHeight).toBeGreaterThanOrEqual(48);
      if (scale === 100 || scale === 200) await page.locator('.commute-picker').screenshot({ path: `test-results/city-review-${skin}-${lang}-${width}-${scale}.png` });
    }
    if (skin === 'clean') expect((await new AxeBuilder({ page }).include('.commute-picker').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations).toEqual([]);
    await page.getByRole('button', { name: t.selection.save, exact: true }).click();
    await expect(home.locator('[data-end="from"] .highway-name')).toHaveText('Fort Lee');
    expect(await stored(page)).toEqual([{ ...favorites[0], fromStopId: '1' }, favorites[1]]);
    const checklist = await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.penn-guide.v1.bus')!));
    expect(checklist).toMatchObject({ step: 3, travelling: true, walks: { summit: 8 } });
  });
}
for (const lang of ['en', 'es'] as const) test(`wrong-side correction remains explicit and cancel/back do not save (${lang})`, async ({ page }) => {
  const { t, favorites } = await setup(page, lang, 'clean', '5', '1'), s = t.cityPicker;
  const destination = page.locator('[data-favorite-id="home"] [data-end="to"] .city-control');
  await destination.click();
  await page.getByRole('button', { name: new RegExp('^' + t.commuteNewYork) }).click();
  await page.locator('.stop-choice').click();
  await expect(page.getByRole('button', { name: t.useThatStop, exact: true })).toBeVisible();
  await page.getByRole('button', { name: t.selection.save, exact: true }).click();
  await expect(page.locator('.commute-picker')).toBeVisible();
  expect(await stored(page)).toEqual(favorites);
  await page.getByRole('button', { name: t.useThatStop, exact: true }).click();
  await expect(page.locator('.picker-review')).toContainText('State Street at Lawrence Street');
  expect(await stored(page)).toEqual(favorites);
  await page.getByRole('button', { name: t.back, exact: true }).click();
  await expect(destination).toBeFocused();
  expect(await stored(page)).toEqual(favorites);
});
test('reverse editing preserves directional walking plans, active bus identity and favorite order', async ({ page }) => {
  const { t, favorites } = await setup(page, 'en');
  const home = page.locator('[data-favorite-id="home"]');
  await home.locator('.dep').first().click();
  await page.getByRole('button', { name: t.lockBus, exact: true }).click();
  const locked = await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.lock.v1.g2')!));
  await page.getByRole('button', { name: t.back, exact: true }).click();
  await home.getByRole('button', { name: t.reverse, exact: true }).click();
  await home.locator('[data-end="to"] .stop-control').click();
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await page.locator('.stop-choice').filter({ hasText: t.selection.stopNumber('30005') }).click();
  await page.getByRole('button', { name: t.selection.save, exact: true }).click();
  await expect(home.locator('[data-end="from"] .highway-name')).toHaveText(t.commuteNewYork);
  expect(await stored(page)).toEqual([{ ...favorites[0], fromStopId: '3', toStopId: '5', leave: { out: favorites[0]!.leave!.back, back: favorites[0]!.leave!.out } }, favorites[1]]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.lock.v1.g2')!))).toMatchObject({ dep: locked.dep, leg: locked.leg, session: { id: locked.session.id, lock: locked.session.lock } });
});
test('unverified provider city text never defines a city group', async ({ page }) => {
  const { t } = await setup(page, 'en', 'clean', '2', '3', false);
  await page.locator('[data-favorite-id="home"] [data-end="from"] .city-control').click();
  await expect(page.locator('.city-choice strong')).toHaveText([t.commuteNewYork, t.selection.unknownCity]);
  await expect(page.locator('.city-choice')).not.toContainText(['Hackensack', 'Fort Lee']);
});


for (const lang of ['en', 'es'] as const) test(`saving an unknown-city stop restores focus when the street control disappears (${lang})`, async ({ page }) => {
  const { t, favorites } = await setup(page, lang, 'clean', '2', '3', true, '1');
  const home = page.locator('[data-favorite-id="home"]');
  await home.locator('[data-end="from"] .stop-control').click();
  await page.getByRole('button', { name: t.cityPicker.changeCity, exact: true }).click();
  await page.locator('.city-choice').filter({ hasText: t.selection.unknownCity }).click();
  await page.locator('.stop-choice').click();
  await page.getByRole('button', { name: t.selection.save, exact: true }).click();
  await expect(home.locator('[data-end="from"] .stop-control')).toHaveCount(0);
  await expect(home.locator('[data-end="from"] .city-control')).toBeFocused();
  expect(await stored(page)).toEqual([{ ...favorites[0], fromStopId: '1' }, favorites[1]]);
});
