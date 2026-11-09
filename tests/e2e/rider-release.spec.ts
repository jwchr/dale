import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { liveDataset, NOW } from '../helpers/liveBus';
const API = 'https://dale-live.test.workers.dev';
test.use({ serviceWorkers: 'block' });

test('stop descriptions precede selection; final Port Authority first; city groups and top/bottom Save share one action', async ({ page }) => {
  const ds = structuredClone(liveDataset);
  Object.assign(ds.stops.find(s => s.id === '2')!, { city: 'Hackensack', code: '32728', name: 'STATE ST AT LAWRENCE ST' });
  await page.clock.install({ time: NOW });
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: ds }));
  await page.route(API + '/v1/departures?**', r => r.abort('failed'));
  await page.goto('/?live=1');
  const about = page.locator('details.live-mode'); await expect(about).not.toHaveAttribute('open');
  await page.getByRole('button', { name: /Find a stop/ }).first().click();
  await page.getByRole('searchbox').fill('Lawrence');
  const choice = page.getByRole('button', { name: /^STATE ST AT LAWRENCE ST/ });
  await expect(choice).toContainText('Stop #32728'); await expect(choice).toContainText('Toward: New York · Port Authority');
  await choice.click();
  await expect(page.locator('.route-descriptions li')).toHaveCount(1);
  const saves = page.getByRole('button', { name: 'Save trip', exact: true }); await expect(saves).toHaveCount(2);
  await saves.first().click(); await expect(page.getByRole('alert')).toContainText('Choose a destination');
  await expect(page.getByRole('heading', { name: 'Where are you going?' })).toBeFocused();
  await page.getByRole('button', { name: 'PORT AUTHORITY BUS TERMINAL', exact: true }).click();
  await saves.last().click();
  await expect(page.getByRole('article')).toHaveCount(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toMatchObject([{ fromStopId: '2', toStopId: '3' }]);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
});

test('city destinations use native keyboard disclosures and keep Port Authority above them', async ({ page }) => {
  await page.goto('/?now=2026-11-04T07:50');
  await page.getByRole('button', { name: /Find a stop/ }).first().click(); await page.getByRole('searchbox').fill('irvington');
  await page.getByRole('button', { name: /Irvington St. \(to New York\)/ }).click();
  const city = page.locator('.destination-cities details').filter({ has: page.locator('summary', { hasText: /^Hackensack/ }) });
  await expect(city).not.toHaveAttribute('open'); await city.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(city).toHaveAttribute('open', '');
  await expect(city.getByRole('button').first()).toBeVisible();
  await city.getByRole('button').first().click();
  await page.getByRole('button', { name: 'Save trip', exact: true }).first().click(); await expect(page.getByRole('article')).toHaveCount(1);
});

test('one local photo is held across navigation; failed image retains original art', async ({ page }) => {
  const requested = new Set<string>(); page.on('request', r => { if (r.url().includes('/backgrounds/') && r.url().endsWith('.webp')) requested.add(r.url()); });
  await page.goto('/?now=2026-11-04T07:50'); await expect(page.locator('.photo-backdrop')).toHaveCount(1);
  const choice = await page.locator('.photo-backdrop').getAttribute('data-photo');
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('.photo-backdrop')).toHaveAttribute('data-photo', choice!); expect(requested.size).toBe(1);
  await page.route('**/backgrounds/*.webp', r => r.abort('failed')); await page.reload();
  await expect(page.locator('.skin-backdrop svg')).toHaveCount(1); await expect(page.locator('.photo-backdrop')).toHaveCount(0);
  await page.emulateMedia({ forcedColors: 'active' }); await expect(page.locator('.skin-backdrop')).toBeHidden();
});

test('rail heading uses New York while station instructions retain New York Penn', async ({ page }) => {
  await page.goto('/?now=2026-11-04T07:50'); await page.getByRole('button', { name: 'Train', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hackensack ↔ New York', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'NEW YORK', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.journey-step')).toContainText('New York Penn');
});
