import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Positions here are invented, next to invented demo stops; no real rider location is used.
test.use({ serviceWorkers: 'block' });

test.describe('with location allowed', () => {
  test.use({ permissions: ['geolocation'], geolocation: { latitude: 40.8701, longitude: -74.0400, accuracy: 25 } });

  test('suggests nearby demo stops; the rider picks one and the direction guard still applies', async ({ page }) => {
    await page.goto('/?now=2026-11-04T07:50&demo');
    await page.getByRole('button', { name: /find a stop/i }).first().click();
    await expect(page.locator('.near-me')).toContainText('Dale does not save it or send it anywhere.');
    await page.getByRole('button', { name: 'Stops near me' }).click();
    const list = page.locator('.near-me .results li');
    await expect(list).toHaveCount(2);
    await expect(list.first()).toContainText('Maple Ave & Main St (to NYC)');
    await expect(page.locator('.near-me')).toContainText('good to about 25 m');
    await expect(page.locator('.near-me')).toContainText('straight lines, not walking routes');
    const { violations } = await new AxeBuilder({ page }).include('.near-me').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
    await list.nth(1).click(); // the stop across the street
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Maple Ave & Main St (to Demo Terminal)');
    await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
    await expect(page.getByRole('alert')).toContainText('Wrong side of the street');
  });
});

test.describe('with a rough location', () => {
  test.use({ permissions: ['geolocation'], geolocation: { latitude: 40.8701, longitude: -74.0400, accuracy: 400 } });
  test('warns that the first stop may not be the closest', async ({ page }) => {
    await page.goto('/?now=2026-11-04T07:50&demo');
    await page.getByRole('button', { name: /find a stop/i }).first().click();
    await page.getByRole('button', { name: 'Stops near me' }).click();
    await expect(page.locator('.near-me')).toContainText('Your location is rough');
  });
});

test('location turned off: says so and points to search by name', async ({ page, context }) => {
  await context.clearPermissions();
  await page.goto('/?now=2026-11-04T07:50&demo');
  await page.getByRole('button', { name: /find a stop/i }).first().click();
  await page.getByRole('button', { name: 'Stops near me' }).click();
  await expect(page.locator('.near-me')).toContainText('Location permission was denied');
});

test('a browser that never answers: gives up after a while and the button still works', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: () => undefined }, configurable: true });
  });
  await page.clock.install();
  await page.goto('/?now=2026-11-04T07:50&demo');
  await page.getByRole('button', { name: /find a stop/i }).first().click();
  await page.getByRole('button', { name: 'Stops near me' }).click();
  await expect(page.locator('.near-me')).toContainText('Asking your device');
  await expect(page.getByRole('button', { name: 'Stops near me' })).toBeDisabled();
  await page.clock.runFor(21_000);
  await expect(page.locator('.near-me')).toContainText('Finding your location took too long');
  await expect(page.getByRole('button', { name: 'Stops near me' })).toBeEnabled();
});

test('a browser without location: says so', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true }); });
  await page.goto('/?now=2026-11-04T07:50&demo');
  await page.getByRole('button', { name: /find a stop/i }).first().click();
  await page.getByRole('button', { name: 'Stops near me' }).click();
  await expect(page.locator('.near-me')).toContainText('This browser cannot share a location');
});

test('printed timetable: not offered, and says why', async ({ page }) => {
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await page.getByRole('button', { name: /find a stop/i }).first().click();
  await expect(page.getByRole('button', { name: 'Stops near me' })).toHaveCount(0);
  await expect(page.getByRole('note').filter({ hasText: 'needs stop locations, which the printed timetable does not have' })).toBeVisible();
});

for (const code of [2, 3]) test(`a precise location error ${code} tries one approximate lookup and ignores late precise results`, async ({ page }) => {
  await page.addInitScript(errorCode => {
    const calls: PositionOptions[] = [];
    (window as any).locationCalls = calls;
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(success: PositionCallback, error: PositionErrorCallback, options: PositionOptions) {
        calls.push(options);
        if (options.enableHighAccuracy) {
          (window as any).latePosition = () => success({ coords: { latitude: 0, longitude: 0, accuracy: 1 } } as GeolocationPosition);
          error({ code: errorCode } as GeolocationPositionError);
        } else success({ coords: { latitude: 40.8701, longitude: -74.04, accuracy: 400 } } as GeolocationPosition);
      },
    } });
  }, code);
  await page.goto('/?now=2026-11-04T07:50&demo');
  await page.getByRole('button', { name: /Find a stop/i }).click();
  await page.getByRole('button', { name: 'Stops near me' }).click();
  await expect(page.locator('.near-me .results li')).toHaveCount(2);
  await expect(page.locator('.near-me')).toContainText('Your location is rough');
  expect(await page.evaluate(() => (window as any).locationCalls.map((c: PositionOptions) => c.enableHighAccuracy))).toEqual([true, false]);
  await page.evaluate(() => (window as any).latePosition());
  await expect(page.locator('.near-me .results li')).toHaveCount(2);
});

test('denial never triggers an approximate retry; unavailable on both attempts explains OS settings', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).geoErrorCode = 1;
    (window as any).geoCalls = 0;
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(_success: PositionCallback, error: PositionErrorCallback) {
        (window as any).geoCalls++;
        error({ code: (window as any).geoErrorCode } as GeolocationPositionError);
      },
    } });
  });
  await page.goto('/?now=2026-11-04T07:50&demo');
  await page.getByRole('button', { name: /Find a stop/i }).click();
  await page.getByRole('button', { name: 'Stops near me' }).click();
  await expect(page.locator('.near-me')).toContainText('Location permission was denied');
  expect(await page.evaluate(() => (window as any).geoCalls)).toBe(1);
  await page.evaluate(() => { (window as any).geoErrorCode = 2; });
  await page.getByRole('button', { name: 'Stops near me' }).click();
  await expect(page.locator('.near-me')).toContainText('even if you clicked Allow');
  expect(await page.evaluate(() => (window as any).geoCalls)).toBe(3);
  await page.getByText('Location help for this device', { exact: true }).click();
  await expect(page.locator('.near-me')).toContainText('System Settings → Privacy & Security → Location Services');
});

test('a late result after timeout cannot replace a fresh retry', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).geoCallbacks = [];
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(success: PositionCallback) { (window as any).geoCallbacks.push(success); },
    } });
  });
  await page.clock.install();
  await page.goto('/?now=2026-11-04T07:50&demo');
  await page.getByRole('button', { name: /Find a stop/i }).click();
  await page.getByRole('button', { name: 'Stops near me' }).click();
  await page.clock.runFor(21_000);
  await page.getByRole('button', { name: 'Stops near me' }).click();
  await page.evaluate(() => {
    (window as any).geoCallbacks[2]({ coords: { latitude: 40.8701, longitude: -74.04, accuracy: 25 } });
    (window as any).geoCallbacks[1]({ coords: { latitude: 0, longitude: 0, accuracy: 1 } });
  });
  await expect(page.locator('.near-me .results li')).toHaveCount(2);
  await expect(page.locator('.near-me')).toContainText('good to about 25 m');
});
