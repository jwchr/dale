import { expect, test } from '@playwright/test';
import { strings } from '../../src/ui/i18n';

// Owner requests 2026-11-11 from his phone: half-and-half toolbar, bigger centered wordmark, slogan beside it,
// whole city names on wide screens, and the September sunset photo showing the skyline at the bottom.
const favorites = [{ id: 'reference', label: 'Hackensack → New York', fromStopId: 'N10', toStopId: 'PABT', routeIds: [] }];
test.use({ serviceWorkers: 'block' });
for (const lang of ['en', 'es'] as const) test(`home top polish (${lang})`, async ({ page }) => {
  const t = strings[lang];
  await page.addInitScript(({ lang, favorites }) => {
    Math.random = () => 0.9; // The September sunset photo.
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, theme: 'dark', skin: 'garden' }));
    localStorage.setItem('arriba.favorites.v1', JSON.stringify(favorites));
  }, { lang, favorites });
  for (const width of [390, 674]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?printed=1&now=2026-11-04T07:50');
    await expect(page.locator('.dep').first()).toBeVisible();
    await expect(page.locator('.top .top-slogan')).toHaveText(t.appTagline);
    const layout = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const mode = box('.home-toolbar .travel-mode'), find = box('.home-toolbar .find-stop');
      const wordmark = document.querySelector('.wordmark')!, mark = wordmark.getBoundingClientRect(), settings = box('.top-actions .icon-btn');
      const words = [...document.querySelectorAll('.highway-name .sign-word')].map(word => new Set([...word.querySelectorAll('.sign-word-part')].map(part => Math.round(part.getBoundingClientRect().top))).size);
      const photo = getComputedStyle(document.querySelector('.photo-backdrop')!);
      return { mode: mode.width, find: find.width, sameRow: Math.abs(mode.top - find.top) < 1, markSize: parseFloat(getComputedStyle(wordmark).fontSize),
        centerGap: Math.abs((mark.top + mark.bottom) / 2 - (settings.top + settings.bottom) / 2), words, photo: photo.backgroundPosition };
    });
    const detail = JSON.stringify({ width, layout });
    expect(layout.sameRow, detail).toBe(true);
    // Exactly half and half when the labels fit; Spanish "Autobús" may need slightly more than half at 390px.
    if (lang === 'en') expect(Math.abs(layout.mode - layout.find), detail).toBeLessThanOrEqual(1);
    else expect(layout.mode - layout.find, detail).toBeGreaterThanOrEqual(-1);
    expect(layout.markSize, detail).toBeGreaterThanOrEqual(25);
    expect(layout.centerGap, detail).toBeLessThanOrEqual(1);
    expect(layout.words.every(lines => lines === 1), detail).toBe(true);
    expect(layout.photo, detail).toBe('50% 45%');
  }
});
