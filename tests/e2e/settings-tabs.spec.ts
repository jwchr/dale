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
    await page.getByRole('button', { name: t.settings, exact: true }).click();
  }
  await a.getByRole('button', { name: '5', exact: true }).click();
  await expect.poll(() => saved(a)).toMatchObject({ count: 5 });
  await expect(b.getByRole('button', { name: '5', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await b.getByRole('button', { name: t.themeDark, exact: true }).click();
  await expect.poll(() => saved(a)).toMatchObject({ count: 5, theme: 'dark', lang, skin: 'clean' });
  await expect(a.getByRole('button', { name: t.themeDark, exact: true })).toHaveAttribute('aria-pressed', 'true');
});
