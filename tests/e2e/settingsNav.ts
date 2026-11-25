import type { Page } from '@playwright/test';
import { strings } from '../../src/ui/i18n';

type T = (typeof strings)['en'];
/** Settings tab, then optionally one row down (simpler layout, Nov 24): 'more' for More settings, 'photo' for Home photo. */
export async function openSettings(page: Page, t: T, row?: 'more' | 'photo') {
  await page.getByRole('navigation', { name: t.dash.tabs.label }).getByRole('button', { name: t.dash.tabs.household, exact: true }).click();
  if (row) await page.getByRole('button', { name: new RegExp(`^${row === 'more' ? t.settingsPage.more : t.settingsPage.homePhoto}`) }).click();
}
