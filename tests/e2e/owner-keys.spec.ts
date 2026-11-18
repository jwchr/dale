// The owner key page (public/owner-keys.html): makes the household code and the two Worker secrets for
// locked-phone stop alerts (docs/LOCKED_STOP_ALERTS.md) in the browser, with nothing sent anywhere.
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { normalizeHouseholdCode, validHouseholdCode } from '../../src/domain/lockedAlerts';
import { loadVapid } from '../../worker/web-push';

test('makes a household code, its hash and a VAPID key the Worker accepts, without any network request', async ({ page, context }) => {
  const requests: string[] = [];
  await page.goto('/owner-keys.html');
  page.on('request', (r) => requests.push(r.url()));
  await expect(page.getByRole('heading', { name: 'Dale owner keys' })).toBeVisible();
  await page.getByRole('button', { name: 'Make new keys' }).click();

  // Generation is asynchronous: wait for the outputs instead of reading them right after the click.
  await expect(page.locator('#code')).toHaveText(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  await expect(page.locator('#key')).toHaveText(/^\{.*\}$/);
  const code = (await page.locator('#code').textContent())!;
  const normalized = normalizeHouseholdCode(code);
  expect(validHouseholdCode(normalized)).toBe(true);
  // The hash is what the Worker compares against: SHA-256 of the code as the app normalizes it.
  expect(await page.locator('#hash').textContent()).toBe(createHash('sha256').update(normalized).digest('hex'));
  // A code typed with spaces or in lower case still matches.
  expect(normalizeHouseholdCode(` ${code.toLowerCase().replace(/-/g, ' ')} `)).toBe(normalized);

  const key = (await page.locator('#key').textContent())!;
  expect(Object.keys(JSON.parse(key)).sort()).toEqual(['crv', 'd', 'kty', 'x', 'y']);
  const vapid = await loadVapid(key);
  expect(vapid?.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);

  // Copy puts the exact value on the clipboard.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy' }).first().click();
  await expect(page.getByText('Copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await page.locator('#hash').textContent());

  // A second press makes a completely new set.
  await page.getByRole('button', { name: 'Make new keys' }).click();
  await expect(page.locator('#code')).not.toHaveText(code);
  await expect(page.locator('#key')).not.toHaveText(key);
  await expect(page.locator('#hash')).not.toHaveText(createHash('sha256').update(normalized).digest('hex'));
  expect(requests).toEqual([]);
});

test('reads in Spanish and fits a narrow phone at large text', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/owner-keys.html');
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  await page.getByRole('button', { name: 'Español' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await page.getByRole('button', { name: 'Crear claves nuevas' }).click();
  await expect(page.getByRole('heading', { name: 'Código del hogar' })).toBeVisible();
  await expect(page.locator('#key')).toHaveText(/^\{.*\}$/);
  await expect(page.getByRole('button', { name: 'Copiar' })).toHaveCount(2);
  // Compared with the 320 px set above: on a phone, overflow widens the window itself, so innerWidth is no check.
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('h1, h2, p, li, output, button')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent) }));
  expect(widths).toEqual({ page: 320, overflowing: [] });
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Household code' })).toBeVisible();
});
