import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { strings } from '../../src/ui/i18n';

// NYC, Parkway and Turnpike on the Household layout (#101 part 6, docs/design/mockups/05-07): each screen readable,
// in English and Spanish, on a narrow phone, with the theme's own mark and no sideways scroll.
const favorites = [{ id: 'reference', label: 'Hackensack → New York', fromStopId: 'N10', toStopId: 'PABT', routeIds: [] }];
test.use({ serviceWorkers: 'block' });

async function open(page: Page, skin: string, lang: 'en' | 'es') {
  await page.addInitScript(({ skin, lang, favorites }) => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin, theme: 'light' }));
    localStorage.setItem('arriba.favorites.v1', JSON.stringify(favorites));
  }, { skin, lang, favorites });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await expect(page.locator('.dep-board').first()).toBeVisible();
}

async function readable(page: Page, label: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no sideways scroll`).toBe(true);
  const { violations } = await new AxeBuilder({ page }).include('main').include('.tab-bar').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), label).toEqual([]);
}

for (const skin of ['nyc', 'parkway', 'turnpike'] as const) for (const lang of ['en', 'es'] as const) {
  test(`${skin} theme: Household layout, its own mark, every tab readable (${lang})`, async ({ page }) => {
    const t = strings[lang];
    await open(page, skin, lang);
    expect(await page.evaluate(() => document.documentElement.dataset.look)).toBe('household');
    const mark = await page.locator('.wordmark').evaluate((el) => ({ image: getComputedStyle(el, '::before').backgroundImage, name: getComputedStyle(el, '::after').content }));
    expect(mark.image).toContain('svg');
    expect(mark.name).toBe('"Dale"');
    await readable(page, `${skin} dashboard`);
    await page.screenshot({ path: `test-results/theme-${skin}-${lang}.png`, fullPage: true });
    const nav = page.getByRole('navigation', { name: t.dash.tabs.label });
    for (const [name, ready] of [
      [t.dash.tabs.schedules, () => expect(page.getByRole('heading', { name: t.dash.tabs.schedules, level: 1 })).toBeVisible()],
      [t.dash.tabs.routes, () => expect(page.locator('#stop-search')).toBeVisible()],
      [t.dash.tabs.gates, () => expect(page.locator('.gg-card').first()).toBeVisible()],
      [t.dash.tabs.household, () => expect(page.getByRole('heading', { level: 1 })).toBeVisible()],
    ] as const) {
      await nav.getByRole('button', { name, exact: true }).click();
      await ready();
      await readable(page, `${skin} ${name}`);
    }
  });
}

test('Turnpike city signs stay dark green under white text', async ({ page }) => {
  await open(page, 'turnpike', 'en');
  const sign = page.locator('.highway-sign').first();
  await expect(sign).toBeVisible();
  const style = await sign.evaluate((el) => ({ image: getComputedStyle(el).backgroundImage, color: getComputedStyle(el).color }));
  expect(style.image).toContain('rgb(15, 77, 47)');
  expect(style.image).not.toContain('rgb(246, 243, 232)');
  expect(style.color).toBe('rgb(255, 255, 255)');
});

test('Garden State keeps its own approved look, not the Household layout', async ({ page }) => {
  await open(page, 'garden', 'en');
  expect(await page.evaluate(() => document.documentElement.dataset.look)).toBe('garden');
});
