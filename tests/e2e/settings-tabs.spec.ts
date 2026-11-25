import { expect, test } from '@playwright/test';
import { strings } from '../../src/ui/i18n';

test.use({ serviceWorkers: 'block' });
const saved = (page: import('@playwright/test').Page) => page.evaluate(() => JSON.parse(localStorage.getItem('arriba.settings.v1') ?? '{}'));

// Two open tabs share one settings record. A tab opened earlier must not undo
// a different setting that the other tab just saved (#106 two-tab finding).
for (const lang of ['en', 'es'] as const) test(`a setting saved in one tab survives a different change in another open tab (${lang})`, async ({ context }) => {
  const t = strings[lang];
  await context.addInitScript(lang => {
    if (!localStorage.getItem('arriba.settings.v1')) localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light', count: 3 }));
  }, lang);
  const a = await context.newPage(), b = await context.newPage();
  for (const page of [a, b]) {
    await page.goto('/?printed=1&now=2026-11-04T07:50');
    await page.getByRole('button', { name: t.dash.tabs.household, exact: true }).click();
  }
  await a.getByRole('button', { name: 'Turnpike', exact: true }).click();
  await expect.poll(() => saved(a)).toMatchObject({ skin: 'turnpike' });
  await expect(b.getByRole('button', { name: 'Turnpike', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await b.getByRole('button', { name: t.themeDark, exact: true }).click();
  await expect.poll(() => saved(a)).toMatchObject({ skin: 'turnpike', theme: 'dark', lang });
  await expect(a.getByRole('button', { name: t.themeDark, exact: true })).toHaveAttribute('aria-pressed', 'true');
});

// CodeRabbit on #167: a snapshot adopted from another tab must never be written back,
// because that tab may already have saved something newer before this tab's save runs.
test('settings adopted from another tab are not written back over a newer save', async ({ page }) => {
  const t = strings.en;
  await page.addInitScript(() => {
    if (!localStorage.getItem('arriba.settings.v1')) localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: 'en', skin: 'clean', theme: 'light', count: 3 }));
  });
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await page.getByRole('button', { name: t.dash.tabs.household, exact: true }).click();
  // Same order a real second tab produces: save, notification here, then a newer save
  // before this page has re-rendered.
  await page.evaluate(() => {
    const key = 'arriba.settings.v1', first = { ...JSON.parse(localStorage.getItem(key)!), skin: 'turnpike' };
    localStorage.setItem(key, JSON.stringify(first));
    window.dispatchEvent(new StorageEvent('storage', { key }));
    localStorage.setItem(key, JSON.stringify({ ...first, theme: 'dark' }));
  });
  await expect(page.getByRole('button', { name: 'Turnpike', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 100))));
  expect(await saved(page)).toMatchObject({ skin: 'turnpike', theme: 'dark' });
  // This tab's own next change still saves, on top of the newest stored values it has seen.
  await page.getByRole('button', { name: t.themeSystem, exact: true }).click();
  await expect.poll(() => saved(page)).toMatchObject({ skin: 'turnpike', theme: 'system' });
});

// #171 review r4593163990: another tab's save can land before this tab hears about it (or the
// notice never arrives). This tab's change must then save only the setting the rider changed.
for (const lang of ['en', 'es'] as const) test(`a change saves only its own setting when another tab's save was not announced (${lang})`, async ({ page }) => {
  const t = strings[lang];
  await page.addInitScript(lang => {
    if (!localStorage.getItem('arriba.settings.v1')) localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light', count: 3 }));
  }, lang);
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await page.getByRole('button', { name: t.dash.tabs.household, exact: true }).click();
  // The other tab's save, with no storage notice reaching this tab.
  await page.evaluate(() => {
    const key = 'arriba.settings.v1';
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)!), bilingualButtons: true, skin: 'turnpike' }));
  });
  await page.getByRole('button', { name: t.themeDark, exact: true }).click();
  await expect.poll(() => saved(page)).toMatchObject({ theme: 'dark', bilingualButtons: true, skin: 'turnpike', lang });
  // The screen now shows the stored values it merged with.
  await expect(page.getByRole('button', { name: 'Turnpike', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: t.themeDark, exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('settings changes still work when this browser refuses to save them', async ({ page }) => {
  const t = strings.en;
  // An older saved record exists, and this browser now refuses every new save (CodeRabbit on #187).
  await page.addInitScript(() => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: 'en', skin: 'clean', theme: 'light', count: 3 }));
    Storage.prototype.setItem = function () { throw new DOMException('blocked', 'QuotaExceededError'); };
  });
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await page.getByRole('button', { name: t.dash.tabs.household, exact: true }).click();
  await page.getByRole('button', { name: 'Turnpike', exact: true }).click();
  await page.getByRole('button', { name: t.themeDark, exact: true }).click();
  // Both in-memory choices hold; the second change did not reset the first.
  await expect(page.getByRole('button', { name: 'Turnpike', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: t.themeDark, exact: true })).toHaveAttribute('aria-pressed', 'true');
});
