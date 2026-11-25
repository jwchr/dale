import { expect, test } from '@playwright/test';
import { strings } from '../../src/ui/i18n';
import { openSettings } from './settingsNav';

// Simpler Settings (mock-up approved Nov 24, 2026): Language, a Style row, Home photo, one Stop alerts
// switch row and More settings up front; each deeper page has a labeled way back that returns focus to its row.
for (const lang of ['en', 'es'] as const) test(`Settings rows open their pages and come back to the same row (${lang})`, async ({ page }) => {
  const t = strings[lang], sp = t.settingsPage;
  await page.addInitScript(lang => { if (!localStorage.getItem('arriba.settings.v1')) localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'garden' })); }, lang);
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await openSettings(page, t);
  // The Style row names the current style; the style and appearance buttons live one tap down.
  const style = page.getByRole('button', { name: new RegExp(`^${sp.style}`) });
  await expect(style).toContainText(t.skins.garden);
  await expect(page.getByRole('button', { name: t.skins.turnpike, exact: true })).toHaveCount(0);
  // Stop alerts is one switch row; the ride-screen note sits inside "What it can and can't do".
  await expect(page.getByRole('checkbox', { name: t.lockedAlerts.title })).toBeVisible();
  await expect(page.getByText(t.lockedAlerts.settingsNote, { exact: true })).toBeHidden();
  for (const [row, title] of [[sp.style, sp.look], [sp.homePhoto, sp.homePhoto], [sp.more, sp.more]] as const) {
    await page.getByRole('button', { name: new RegExp(`^${row}`) }).click();
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeFocused();
    // One title per page: the photo page does not repeat it.
    await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: sp.backTo, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: t.settings, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(`^${row}`) })).toBeFocused();
  }
  // Choosing a style one tap down is reflected on the row.
  await openSettings(page, t, 'look');
  await page.getByRole('button', { name: t.skins.turnpike, exact: true }).click();
  await page.getByRole('button', { name: sp.backTo, exact: true }).click();
  await expect(style).toContainText(t.skins.turnpike);
});

test('the demo data line is in Spanish too', async ({ page }) => {
  const t = strings.es;
  await page.addInitScript(() => { if (!localStorage.getItem('arriba.settings.v1')) localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: 'es' })); });
  await page.goto('/?now=2026-11-04T07:50&demo');
  await openSettings(page, t, 'more');
  await expect(page.getByText(new RegExp(`^${t.settingsPage.demoSource} · `))).toBeVisible();
  await expect(page.getByText(/Invented demo data/)).toHaveCount(0);
});
