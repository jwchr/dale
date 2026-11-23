import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build } from 'vite';
import type { FixtureOptions } from '../fixtures/near-me-refresh';
import { strings } from '../../src/ui/i18n';

declare global {
  interface Window {
    nearMeFixture: { render: (options: FixtureOptions) => void };
    locationCallbacks: { success: PositionCallback; error: PositionErrorCallback }[];
  }
}

let fixture: string;
test.beforeAll(async () => {
  // Bundle the real component for a browser-only lifecycle test. This fixture is never published.
  const built = await build({ configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('development') }, build: {
    write: false, minify: false, lib: {
      entry: fileURLToPath(new URL('../fixtures/near-me-refresh.tsx', import.meta.url)),
      name: 'nearMeFixture', formats: ['iife'],
    },
  } });
  const output = Array.isArray(built) ? built[0] : built;
  if (!output || !('output' in output)) throw new Error('Missing nearby fixture bundle');
  const chunk = output.output.find(item => item.type === 'chunk');
  if (!chunk) throw new Error('Missing nearby fixture script');
  fixture = chunk.code;
});

async function render(page: Page, options: FixtureOptions) {
  await page.evaluate(options => window.nearMeFixture.render(options), options);
}

async function open(page: Page, options: FixtureOptions) {
  await page.setContent(`<html lang="${options.lang}"><head><title>Nearby refresh test</title></head><body><main id="fixture"></main></body></html>`);
  await page.evaluate(() => {
    window.locationCallbacks = [];
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(success: PositionCallback, error: PositionErrorCallback) {
        window.locationCallbacks.push({ success, error });
      },
    } });
  });
  await page.addScriptTag({ content: fixture });
  await render(page, options);
}

async function requests(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => window.locationCallbacks.length)).toBe(count);
}

for (const lang of ['en', 'es'] as const) {
  test(`a dataset refresh retries an unfinished shortcut and ignores its late callback (${lang})`, async ({ page }) => {
    const options = { lang, hasLocations: true };
    await open(page, options);
    await requests(page, 1);
    await render(page, options);
    await requests(page, 2);
    await page.evaluate(() => window.locationCallbacks[0]!.success({
      coords: { latitude: 40.8701, longitude: -74.04, accuracy: 25 },
    } as GeolocationPosition));
    await expect(page.getByRole('status')).toHaveText(strings[lang].nearMe.asking);
    await expect(page.locator('.results li')).toHaveCount(0);
    await page.evaluate(() => window.locationCallbacks[1]!.success({
      coords: { latitude: 40.8701, longitude: -74.04, accuracy: 25 },
    } as GeolocationPosition));
    await expect(page.locator('.results li')).toHaveCount(2);
    await render(page, options);
    await expect(page.getByRole('status')).toBeEmpty();
    await requests(page, 2); // A settled shortcut never asks again on refresh.
  });

  test(`a refresh after denial does not ask again (${lang})`, async ({ page }) => {
    const options = { lang, hasLocations: true };
    await open(page, options);
    await requests(page, 1);
    await page.evaluate(() => window.locationCallbacks[0]!.error({ code: 1 } as GeolocationPositionError));
    await expect(page.getByRole('status')).toHaveText(strings[lang].nearMe.denied);
    await render(page, options);
    await expect(page.getByRole('status')).toBeEmpty();
    await requests(page, 1);
  });

  test(`late stop coordinates move focus from the unavailable note to nearby (${lang})`, async ({ page }) => {
    await open(page, { lang, hasLocations: false });
    await expect(page.getByRole('note')).toBeFocused();
    await requests(page, 0);
    await render(page, { lang, hasLocations: true });
    await expect(page.getByRole('heading', { name: strings[lang].nearMe.button })).toBeFocused();
    await requests(page, 1);
  });

  for (const hidden of [false, true]) test(`late stop coordinates preserve search focus (hidden=${hidden}, ${lang})`, async ({ page }) => {
    await open(page, { lang, hasLocations: false });
    await expect(page.getByRole('note')).toBeFocused();
    await page.locator('#stop-search').fill('Broad');
    await render(page, { lang, hasLocations: true, hidden });
    await requests(page, hidden ? 0 : 1);
    await expect(page.locator('#stop-search')).toBeFocused();
    await render(page, { lang, hasLocations: true, hidden });
    await requests(page, hidden ? 0 : 2); // Hidden dataset refreshes must not ask either.
    await page.locator('#stop-search').clear();
    await render(page, { lang, hasLocations: true, refresh: false });
    await expect(page.locator('#stop-search')).toBeFocused();
    await requests(page, hidden ? 1 : 2); // Showing the same dataset consumes the shortcut once.
  });

  test(`late stop coordinates do not focus a hidden nearby view (${lang})`, async ({ page }) => {
    await open(page, { lang, hasLocations: false });
    await expect(page.getByRole('note')).toBeFocused();
    await render(page, { lang, hasLocations: true, hidden: true });
    await requests(page, 0);
    await expect(page.locator('.near-me h2')).not.toBeFocused();
    await expect(page.locator('.near-me')).toBeHidden();
    await render(page, { lang, hasLocations: true, refresh: false });
    await expect(page.locator('.near-me')).toBeVisible();
    await requests(page, 1);
  });
}
