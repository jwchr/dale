import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function lockDemoTrip(page: Page, lang: 'en' | 'es' = 'en') {
  const es = lang === 'es';
  if (es) await page.addInitScript(() => localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: 'es' })));
  await page.goto('/?now=2026-11-04T07:50&demo');
  await page.getByRole('button', { name: es ? 'Buscar parada' : 'Find a stop' }).first().click();
  await page.getByRole('searchbox').fill('90002');
  await page.getByRole('button', { name: /Maple Ave & Main St/ }).click();
  await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
  await page.getByRole('button', { name: es ? 'Guardar viaje' : 'Save trip', exact: true }).first().click();
  await page.locator('.dep').first().click();
  await page.getByRole('button', { name: es ? 'Seguir este autobús' : 'Lock onto this bus' }).click();
}

test('demo card is labeled sample history, toggles 1 and 5 minutes, and fits a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await lockDemoTrip(page);
  const card = page.locator('.how-sure');
  await expect(card.getByRole('heading', { name: /How sure are we\?/ })).toBeVisible();
  await expect(card.locator('.how-sure-badge')).toHaveText('Demo');
  await expect(card).toContainText('Demo · all sample history');
  await expect(card).toContainText('fictional');
  await expect(card).toContainText('Scheduled for');
  await expect(card).not.toContainText(/\bLIVE\b/);
  const five = card.getByRole('button', { name: '5 min' }), one = card.getByRole('button', { name: '1 min' });
  await expect(five).toHaveAttribute('aria-pressed', 'true');
  const fiveRows = await card.locator('.how-sure-bars li').count();
  await one.click();
  await expect(one).toHaveAttribute('aria-pressed', 'true');
  expect(await card.locator('.how-sure-bars li').count()).toBeGreaterThan(fiveRows);
  await expect(card).toContainText('Scroll through every arrival');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const axe = await new AxeBuilder({ page }).include('.how-sure').analyze();
  expect(axe.violations).toEqual([]);
});

test('Spanish card has every label translated', async ({ page }) => {
  await lockDemoTrip(page, 'es');
  const card = page.locator('.how-sure');
  await expect(card.getByRole('heading', { name: /¿Qué tan seguros estamos\?/ })).toBeVisible();
  await expect(card).toContainText('El libro de récords');
  await expect(card).toContainText('Cómo se calcula.');
  await expect(card).not.toContainText(/Record book|Scheduled for|trips\b/);
});

test('a stop time Dale estimated is never measured, and nothing is shown as a pattern', async ({ page }) => {
  const { demoDataset } = await import('../../src/data/demo');
  const ds = structuredClone(demoDataset);
  ds.trips = ds.trips.map((trip) => ({ ...trip, estimated: [1] }));
  await page.route('**/data/corridor.json', (route) => route.fulfill({ json: ds }));
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await page.getByRole('button', { name: 'Find a stop' }).first().click();
  await page.getByRole('searchbox').fill('90002');
  await page.getByRole('button', { name: /Maple Ave & Main St \(to NYC\)/ }).click();
  await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
  await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
  await page.locator('.dep').first().click();
  await page.getByRole('button', { name: 'Lock onto this bus' }).click();
  const card = page.locator('.how-sure');
  await expect(card).toContainText('Not measured for this trip.');
  await expect(card.locator('.how-sure-bars')).toHaveCount(0);
  await expect(card.locator('.how-sure-badge')).toHaveText('Past arrivals');
});
