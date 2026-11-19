import { test, expect } from '@playwright/test';
import { strings } from '../../src/ui/i18n';
test.use({ serviceWorkers: 'block' });
const URL = '/?printed=1&now=2026-11-04T07:50';

for (const lang of ['en', 'es'] as const) test(`a fresh install opens in Household, first in the style list (${lang})`, async ({ page }) => {
  const t = strings[lang];
  // Only the language is saved: no style has ever been chosen on this phone.
  await page.addInitScript(lang => { if (!localStorage.getItem('arriba.settings.v1')) localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang })); }, lang);
  await page.goto(URL);
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'household');
  // Household is always light, whatever the phone's dark-mode setting.
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light');
  await expect(page.locator('.photo-backdrop')).toHaveAttribute('data-photo', 'paterson-great-falls');
  await page.getByRole('button', { name: t.settings, exact: true }).click();
  await expect(page.getByRole('button', { name: t.skins.household, exact: true })).toHaveAttribute('aria-pressed', 'true');
  // The style list sits under the "Style" heading; Household comes first.
  const styles = page.getByRole('heading', { name: t.skin, exact: true }).locator('xpath=following-sibling::div[1]').getByRole('button');
  await expect(styles).toHaveText([t.skins.household, t.skins.garden, t.skins.turnpike, t.skins.parkway, t.skins.nyc, t.skins.clean]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.settings.v1')!).skin)).toBe('household');
});

test('an existing install keeps its saved Garden State style', async ({ page }) => {
  await page.addInitScript(() => { if (!localStorage.getItem('arriba.settings.v1')) localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: 'en', skin: 'garden' })); });
  await page.goto(URL);
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'garden');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'garden');
  await page.getByRole('button', { name: strings.en.settings, exact: true }).click();
  await expect(page.getByRole('button', { name: strings.en.skins.garden, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: strings.en.skins.household, exact: true })).toHaveAttribute('aria-pressed', 'false');
});
