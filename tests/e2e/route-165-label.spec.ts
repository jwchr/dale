import { expect, test } from '@playwright/test';
import { strings } from '../../src/ui/i18n';

test.use({ serviceWorkers: 'block' });

for (const lang of ['en', 'es'] as const) test(`mixed gate rows distinguish local and Turnpike at 320px and 200% text (${lang})`, async ({ page }) => {
  const t = strings[lang];
  await page.addInitScript((lang) => {
    localStorage.setItem('arriba.favorites.v1', JSON.stringify([
      { id: 'mixed', label: 'Home', fromStopId: 'PABT', toStopId: 'W10', routeIds: ['R165', 'R165T'] },
    ]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'household', count: 5, tourSeen: true }));
  }, lang);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/?printed=1&now=2026-11-04T17:00');
  await page.getByRole('navigation', { name: t.dash.tabs.label }).getByRole('button', { name: t.dash.tabs.gates, exact: true }).click();
  await expect(page.locator('.gate-trip')).toHaveCount(1);
  const rows = page.locator('.gate-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.locator('.route-badge')).toHaveText(['165', '165', '165', '165', '165']);
  const express = rows.filter({ has: page.locator('.gate-service', { hasText: t.gateTurnpikeExpress }) });
  const local = rows.filter({ has: page.locator('.gate-service', { hasText: /^165 / }) });
  expect(await express.count()).toBeGreaterThan(0);
  expect(await local.count()).toBeGreaterThan(0);
  // textContent joins the separate badge and service label into "165Turnpike express".
  await expect(page.locator('.gate-trip')).not.toContainText('165T', { useInnerText: true });
  for (const size of [100, 200]) {
    await page.addStyleTag({ content: `html { font-size: ${size}% !important; } body { font-size: 1rem !important; }` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // The complete service label stays inside its button and clear of the badge and arrow.
    for (const row of await rows.all()) {
      const button = (await row.boundingBox())!, badge = (await row.locator('.route-badge').boundingBox())!;
      const label = (await row.locator('.gate-service').boundingBox())!, arrow = (await row.locator('svg').boundingBox())!;
      expect(label.x).toBeGreaterThanOrEqual(badge.x + badge.width);
      expect(label.x + label.width).toBeLessThanOrEqual(arrow.x);
      expect(label.y).toBeGreaterThanOrEqual(button.y);
      expect(label.y + label.height).toBeLessThanOrEqual(button.y + button.height);
      expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await page.screenshot({ path: `test-results/route-165-gates-${lang}-${size}.png`, fullPage: true });
  }
  await express.first().click();
  await expect(page.locator('.sign-led')).toContainText('Turnpike Exp');
  await page.getByRole('button', { name: t.lockBus, exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.lock.v1')!));
  expect(saved.dep.route.id).toBe('R165T');
  expect(saved.session.lock.tripInstanceId).toBe(saved.dep.tripInstanceId);
});

for (const lang of ['en', 'es'] as const) test(`saved Turnpike bus keeps its identity and shows 165 throughout the trip (${lang})`, async ({ page }) => {
  const t = strings[lang];
  const favorite = { id: 'express', label: 'Morning', fromStopId: 'N19', toStopId: 'PABT', routeIds: ['R165T'] };
  await page.addInitScript(({ favorite, lang }) => {
    localStorage.setItem('arriba.favorites.v1', JSON.stringify([favorite]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'household', count: 3, tourSeen: true }));
  }, { favorite, lang });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  const card = page.locator('article[data-favorite-id="express"]');
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
