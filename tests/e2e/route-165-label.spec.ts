import { expect, test } from '@playwright/test';
import { strings } from '../../src/ui/i18n';

test.use({ serviceWorkers: 'block' });

for (const lang of ['en', 'es'] as const) test(`saved Turnpike bus keeps its identity and shows 165 throughout the trip (${lang})`, async ({ page }) => {
  const t = strings[lang];
  const favorite = { id: 'express', label: 'Morning', fromStopId: 'N19', toStopId: 'PABT', routeIds: ['R165T'] };
  await page.addInitScript(({ favorite, lang }) => {
    localStorage.setItem('arriba.favorites.v1', JSON.stringify([favorite]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'household', count: 3, tourSeen: true }));
  }, { favorite, lang });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  const card = page.getByRole('article');
  await expect(card.locator('.dep .route-badge')).toHaveText(['165', '165', '165']);
  await expect(card.locator('.dep-dest').first()).toContainText('Turnpike Exp');
  await expect(page.locator('body')).not.toContainText('165T');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/route-165-home-${lang}.png`, fullPage: true });

  await page.getByRole('button', { name: t.dash.fullDay, exact: true }).click();
  const rows = page.locator('table.timetable tbody tr');
  await expect(rows.first().locator('.route-badge')).toHaveText('165');
  await expect(rows.first()).toContainText('Turnpike Exp');
  await expect(page.locator('body')).not.toContainText('165T');
  await page.screenshot({ path: `test-results/route-165-schedule-${lang}.png`, fullPage: true });
  await page.locator('table.timetable tbody tr:not(.past) button').first().click();
  await expect(page.locator('.sign-led')).toContainText('165');
  await expect(page.locator('.sign-led')).toContainText('Turnpike Exp');
  await expect(page.locator('.fare-card')).toBeVisible();
  await page.getByRole('button', { name: t.boarding.open, exact: true }).click();
  await expect(page.locator('.boarding-check')).toContainText('165 · Turnpike Exp');
  await page.getByRole('button', { name: t.boarding.showCard, exact: true }).click();
  await expect(page.locator('.driver-route')).toContainText('Turnpike Exp');
  await expect(page.locator('body')).not.toContainText('165T');
  await page.getByRole('button', { name: t.boarding.closeCard, exact: true }).click();
  await page.getByRole('button', { name: t.back, exact: true }).click();
  await page.getByRole('button', { name: t.lockBus, exact: true }).click();
  await expect(page.locator('.lock-route')).toContainText('Turnpike Exp');
  await page.getByRole('button', { name: t.share.open, exact: true }).click();
  await expect(page.getByTestId('share-text')).toContainText('165 · Turnpike Exp');
  await expect(page.locator('body')).not.toContainText('165T');
  const saved = await page.evaluate(() => ({ favorite: JSON.parse(localStorage.getItem('arriba.favorites.v1')!)[0],
    lock: JSON.parse(localStorage.getItem('arriba.lock.v1')!) }));
  expect(saved.favorite).toEqual(favorite);
  expect(saved.lock.dep.route).toMatchObject({ id: 'R165T', shortName: '165T' });
  expect(saved.lock.session.lock.tripInstanceId).toBe(saved.lock.dep.tripInstanceId);
});
