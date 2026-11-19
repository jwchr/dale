import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { strings } from '../../src/ui/i18n';
test.use({ serviceWorkers: 'block' });

for (const skin of ['household', 'turnpike', 'parkway', 'nyc', 'garden', 'clean']) for (const lang of ['en', 'es'] as const) {
  test(`all-day times remain reachable on enlarged narrow phones (${skin}, ${lang})`, async ({ page }) => {
    const t = strings[lang];
    await page.addInitScript(({ skin, lang }) => localStorage.setItem('arriba.settings.v1', JSON.stringify({ skin, lang, theme: 'light' })), { skin, lang });
    await page.goto('/?printed=1&now=2026-11-04T07:50');
    await page.getByRole('button', { name: t.findStop, exact: true }).first().click();
    await page.getByRole('searchbox').fill('irvington');
    await page.getByRole('button', { name: /Irvington St\. \(to New York\)/ }).click();
    await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
    await page.getByRole('button', { name: t.selection.save, exact: true }).first().click();
    await page.getByRole('button', { name: t.allDay }).click();
    for (const width of [305, 320, 390]) for (const scale of [100, 200]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      expect(await page.getByRole('heading', { level: 1 }).evaluate(heading => {
        const range = document.createRange(); range.selectNodeContents(heading);
        const box = heading.getBoundingClientRect();
        return [...range.getClientRects()].every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1);
      })).toBe(true);
    }
    const region = page.getByRole('region', { name: t.timetableTitle, exact: true });
    await expect(region).toBeVisible({ timeout: 1000 });
    await region.focus(); await expect(region).toBeFocused();
    await page.setViewportSize({ width: 305, height: 1000 });
    const before = await region.evaluate(el => el.scrollLeft);
    if (await region.evaluate(el => el.scrollWidth > el.clientWidth + 1)) {
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => region.evaluate(el => el.scrollLeft)).toBeGreaterThan(before);
    }
    // Keyboard activation still opens the same scheduled trip.
    const first = region.locator('.link-cell').first();
    await first.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.trip-ticket')).toBeVisible();
    await page.getByRole('button', { name: t.back, exact: true }).click();
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations.map(v => v.id)).toEqual([]);
  });
}
