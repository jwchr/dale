import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { strings } from '../../src/ui/i18n';
import { OPENING_SLOGAN_KEY } from '../../src/domain/openingSlogan';
import type { Skin } from '../../src/ui/SkinBackdrop';
test.use({ serviceWorkers: 'block' });
const URL = '/?printed=1&now=2026-11-04T07:50';
const favorite = { id: 'opening', label: 'Fixture commute', fromStopId: 'N10', toStopId: 'PABT', routeIds: [] };
async function setup(page: Page, lang: 'en' | 'es', skin = 'clean', rotateSlogans = false) {
  await page.addInitScript(({ lang, skin, rotateSlogans, favorite }) => {
    Math.random = () => .5;
    // Seed once, so reload tests exercise the actual saved preferences.
    if (!sessionStorage.getItem('opening-seeded')) {
      localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin, theme: 'light', rotateSlogans }));
      localStorage.setItem('arriba.favorites.v1', JSON.stringify([favorite]));
      sessionStorage.setItem('opening-seeded', '1');
    }
  }, { lang, skin, rotateSlogans, favorite });
  await page.goto(URL); await expect(page.locator('.top-slogan')).toBeVisible();
}

for (const lang of ['en', 'es'] as const) {
  const t = strings[lang];
  test(`opt-in starts on next fresh load, stays fixed during use, and can be turned off (${lang})`, async ({ page }) => {
    await setup(page, lang);
    await expect(page.locator('.top-slogan')).toHaveText(t.appTagline);
    expect(await page.evaluate(key => localStorage.getItem(key), OPENING_SLOGAN_KEY)).toBeNull();
    const favoritesBefore = await page.evaluate(() => localStorage.getItem('arriba.favorites.v1'));
    await page.getByRole('button', { name: t.dash.tabs.household, exact: true }).click();
    const group = page.getByRole('group', { name: t.slogans.title });
    await expect(group.getByRole('button', { name: t.slogans.fixed })).toHaveAttribute('aria-pressed', 'true');
    await group.getByRole('button', { name: t.slogans.rotate }).focus(); await page.keyboard.press('Enter');
    await expect(group.getByRole('button', { name: t.slogans.rotate })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.top-slogan')).toHaveText(t.appTagline);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('arriba.settings.v1')!).rotateSlogans)).toBe(true);
    await page.reload();
    const first = await page.locator('.top-slogan').textContent(); expect(t.slogans.candidates).toContain(first);
    const index = await page.evaluate(key => localStorage.getItem(key), OPENING_SLOGAN_KEY);
    await page.getByRole('button', { name: t.dash.tabs.household, exact: true }).click();
    await page.getByRole('button', { name: lang === 'en' ? 'Español' : 'English', exact: true }).click();
    const other = strings[lang === 'en' ? 'es' : 'en'];
    await expect(page.locator('.top-slogan')).toHaveText(other.slogans.candidates[Number(index) - 1]!);
    await page.getByRole('button', { name: lang === 'en' ? 'English' : 'Español', exact: true }).click();
    await page.getByRole('button', { name: t.back, exact: true }).click();
    await expect(page.locator('.top-slogan')).toHaveText(first!);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('.top-slogan')).toHaveText(first!);
    expect(await page.evaluate(key => localStorage.getItem(key), OPENING_SLOGAN_KEY)).toBe(index);
    await page.reload(); await expect(page.locator('.top-slogan')).not.toHaveText(first!);
    await page.getByRole('button', { name: t.dash.tabs.household, exact: true }).click();
    await page.getByRole('group', { name: t.slogans.title }).getByRole('button', { name: t.slogans.fixed }).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('arriba.settings.v1')!).rotateSlogans)).toBe(false);
    await page.reload(); await expect(page.locator('.top-slogan')).toHaveText(t.appTagline);
    expect(await page.evaluate(() => localStorage.getItem('arriba.favorites.v1'))).toBe(favoritesBefore);
  });

  const skins: readonly Skin[] = ['household', 'garden', 'turnpike', 'parkway', 'nyc', 'clean'];
  for (const skin of skins) test(`optional slogan and choices fit narrow large text (${lang}, ${skin})`, async ({ page }) => {
    await page.setViewportSize({ width: 305, height: 780 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setup(page, lang, skin, true);
    await page.addStyleTag({ content: 'body { font-size: 32px !important; }' });
    const text = await page.locator('.top-slogan').textContent(); expect(t.slogans.candidates).toContain(text);
    await page.getByRole('button', { name: t.dash.tabs.household, exact: true }).click();
    const group = page.getByRole('group', { name: t.slogans.title });
    for (const button of await group.getByRole('button').all()) {
      await button.focus(); await expect(button).toBeFocused();
      const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.top-slogan')).toHaveText(text!);
    if (skin === 'garden') {
      await page.locator('header').screenshot({ path: `test-results/opening-slogan-header-${lang}-305px-200percent.png` });
      await group.screenshot({ path: `test-results/opening-slogan-choices-${lang}-305px-200percent.png` });
    }
    expect((await new AxeBuilder({ page }).include('header').include('[role="group"]').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  });
}

test('blocked storage keeps the canonical slogan and usable settings', async ({ page }) => {
  await page.addInitScript(() => { Storage.prototype.getItem = () => { throw Error('Synthetic refusal'); }; Storage.prototype.setItem = () => { throw Error('Synthetic refusal'); }; });
  await page.goto(URL); await expect(page.locator('.top-slogan')).toHaveText(strings.en.appTagline);
  await page.getByRole('button', { name: 'Household', exact: true }).click();
  await page.getByRole('button', { name: strings.en.slogans.rotate }).click();
  await expect(page.locator('.top-slogan')).toHaveText(strings.en.appTagline);
});
