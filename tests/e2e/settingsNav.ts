import type { Page } from '@playwright/test';
import { strings } from '../../src/ui/i18n';

type T = (typeof strings)['en'];
/** Settings tab, then optionally one row down (simpler layout, Nov 24): 'look' for Style, 'photo' for Home photo, 'more' for More settings. */
export async function openSettings(page: Page, t: T, row?: 'look' | 'more' | 'photo') {
  await page.getByRole('navigation', { name: t.dash.tabs.label }).getByRole('button', { name: t.dash.tabs.household, exact: true }).click();
  if (row) await page.getByRole('button', { name: new RegExp(`^${{ look: t.settingsPage.style, more: t.settingsPage.more, photo: t.settingsPage.homePhoto }[row]}`) }).click();
}
