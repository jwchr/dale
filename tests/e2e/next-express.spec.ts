import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { expressDataset } from '../helpers/express';
// Keep this intercepted synthetic schedule independent of the production service-worker cache.
test.use({ serviceWorkers: 'block' });
for (const lang of ['en', 'es']) test(`compact next165T cue preserves the three local rows, ${lang}`, async ({ page }) => {
  const ds = expressDataset();
  await page.route('**/data/corridor.json', (route) => route.fulfill({ json: ds }));
  await page.addInitScript((lang) => {
    localStorage.setItem('arriba.favorites.v1', JSON.stringify([{ id: 'express-preview', label: 'Demo commute', fromStopId: 'D1', toStopId: 'PABT', routeIds: [] }]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light', count: 3 }));
  }, lang);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/?printed=1&now=2026-11-04T07:00');
  const card = page.getByRole('article'), cue = card.getByTestId('next-express');
  await expect(card.locator('.dep .route-badge')).toHaveText(['165', '165', '165']);
  await expect(cue).toContainText(lang === 'en' ? 'Next' : 'Próximo');
  await expect(cue).toContainText('165T'); await expect(cue).toContainText(lang === 'en' ? '7:40 AM' : '7:40 a.m.');
  await expect(cue).toContainText(lang === 'en' ? 'in 40 min' : 'en 40 min');
  await expect(cue).toContainText(lang === 'en' ? 'Scheduled only' : 'Solo horario');
  expect(await cue.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThan(await card.locator('.dep-time').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize)));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  if (lang === 'en') await page.screenshot({ path: 'test-results/next-express-preview.png', fullPage: true });
  // Once the express enters the main three rows, the extra cue disappears.
  await page.goto('/?printed=1&now=2026-11-04T07:11');
  await expect(cue).toHaveCount(0); await expect(card.locator('.dep .route-badge')).toContainText(['165', '165T']);
});
