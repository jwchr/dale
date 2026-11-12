import { expect, test, type Page } from '@playwright/test';
import { liveDataset, NOW } from '../helpers/liveBus';
import { strings } from '../../src/ui/i18n';

// Owner decision 2026-11-12: NJ Transit's official schedule from Dale's server is the default; the printed
// timetable stays one tap away. Commutes saved with the printed timetable are never mapped silently.
const API = 'https://dale-live.test.workers.dev';
const printed = [{ id: 'reference', label: 'Hackensack → New York', fromStopId: 'N10', toStopId: 'PABT', routeIds: [] }];

async function open(page: Page, lang: 'en' | 'es', saved: unknown[] | null, url = '/') {
  const requests: string[] = [];
  await page.addInitScript(({ lang, saved }) => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'garden', theme: 'light' }));
    if (saved) localStorage.setItem('arriba.favorites.v1', JSON.stringify(saved));
  }, { lang, saved });
  await page.clock.install({ time: NOW });
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/departures?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', route => { requests.push('schedule'); return route.fulfill({ json: liveDataset }); });
  await page.route('**/data/corridor.json', route => { requests.push('printed'); return route.continue(); });
  await page.goto(url);
  return requests;
}

test.use({ serviceWorkers: 'block' });
for (const lang of ['en', 'es'] as const) {
  const t = strings[lang];

  test(`opens on the official schedule and asks once to update printed commutes (${lang})`, async ({ page }) => {
    const requests = await open(page, lang, printed);
    const card = page.locator('.move-commutes');
    await expect(card.getByRole('heading', { name: t.live.moveTitle })).toBeVisible();
    await expect(card).toContainText(t.live.moveBody(1));
    await expect(card.getByRole('listitem')).toHaveText(['Hackensack → New York']);
    expect(requests).toEqual(['schedule']);
    // The printed commute is kept untouched for the backup timetable, and nothing was copied across.
    expect(await page.evaluate(() => [localStorage.getItem('arriba.favorites.v1'), localStorage.getItem('arriba.favorites.v1.g2')]))
      .toEqual([JSON.stringify(printed), '[]']);
    await card.getByRole('button', { name: t.live.moveFind }).click();
    await expect(page.locator('.move-commutes')).toHaveCount(0);
    await expect(page.getByRole('searchbox').or(page.getByRole('textbox')).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`the printed timetable stays one tap away and is remembered (${lang})`, async ({ page }) => {
    const requests = await open(page, lang, printed);
    await page.locator('.move-commutes').getByRole('link', { name: t.live.backup }).click();
    await expect(page.locator('.dep').first()).toBeVisible();
    await expect(page.locator('[data-end="from"] .highway-name')).toHaveText('Hackensack');
    await page.goto('/');
    await expect(page.locator('.dep').first()).toBeVisible();
    await expect(page.locator('.move-commutes')).toHaveCount(0);
    expect(requests).toEqual(['schedule', 'printed', 'printed']);
  });
}

test('a new rider without printed commutes sees the usual first-stop screen', async ({ page }) => {
  const requests = await open(page, 'en', null);
  await expect(page.getByRole('heading', { name: strings.en.noFavoritesTitle })).toBeVisible();
  await expect(page.locator('.move-commutes')).toHaveCount(0);
  expect(requests).toEqual(['schedule']);
});
