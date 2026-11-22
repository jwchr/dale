import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { strings } from '../../src/ui/i18n';
import { dashboardStrings } from '../../src/ui/dashboardStrings';

// The project config uses Pixel 7. Only invented demo stops and positions are used here.
test.use({ serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { latitude: 40.8701, longitude: -74.04, accuracy: 25 } });

async function openHome(page: Page, lang: 'en' | 'es') {
  await page.addInitScript(lang => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'household', theme: 'light' }));
    localStorage.setItem('arriba.favorites.v1', JSON.stringify([
      { id: 'demo-trip', label: 'Demo trip', fromStopId: 'D2', toStopId: 'PABT', routeIds: [] },
    ]));
  }, lang);
  await page.goto('/?now=2026-11-04T07:50&demo');
}

async function countLocationRequests(page: Page) {
  await page.addInitScript(() => {
    const requests: PositionOptions[] = [];
    Object.assign(window, { locationRequests: requests });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(success: PositionCallback, _error: PositionErrorCallback, options: PositionOptions) {
        requests.push(options);
        // Invented position next to the demo stops. Keep no real device coordinates.
        success({ coords: { latitude: 40.8701, longitude: -74.04, accuracy: 25 } } as GeolocationPosition);
      },
    } });
  });
  return () => page.evaluate(() => (window as Window & { locationRequests?: PositionOptions[] }).locationRequests!.length);
}

for (const lang of ['en', 'es'] as const) {
  for (const clear of ['backspace', 'clear'] as const) test(`clearing a query keeps input focus and one location request at 320px / 200% text (${clear}, ${lang})`, async ({ page }) => {
    const t = strings[lang], calls = await countLocationRequests(page);
    await page.setViewportSize({ width: 320, height: 850 });
    await openHome(page, lang);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    // Mounting home, before the tap, never asks for location.
    expect(await calls()).toBe(0);
    await page.getByRole('button', { name: dashboardStrings[lang].useLocation, exact: true }).click();
    const nearby = page.locator('.near-me'), input = page.locator('#stop-search');
    await expect(nearby.getByRole('heading')).toBeFocused();
    await expect(nearby.locator('.results li')).toHaveCount(2);
    expect(await calls()).toBe(1);
    for (let round = 0; round < 2; round++) {
      await input.fill('Broad');
      await expect(nearby).toBeHidden();
      if (clear === 'backspace') {
        await input.press('End');
        for (let i = 0; i < 'Broad'.length; i++) await input.press('Backspace');
      } else await input.clear();
      await expect(input).toHaveValue('');
      await expect(input).toBeFocused();
      await expect(nearby).toBeVisible();
      await expect(nearby.locator('.results li')).toHaveCount(2);
      expect(await calls()).toBe(1);
    }
    expect(await nearby.evaluate(el => !!(el.compareDocumentPosition(document.querySelector('search')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Continue typing without refocusing the input after clearing it.
    await page.keyboard.type('Maple');
    await expect(input).toHaveValue('Maple');
    await expect(input).toBeFocused();
    expect(await calls()).toBe(1);
    await page.screenshot({ path: `test-results/near-me-query-clear-${clear}-${lang}-320-200.png` });
  });

  test(`city and stop round trips keep nearby results without asking or focusing nearby again (${lang})`, async ({ page }) => {
    const t = strings[lang], calls = await countLocationRequests(page);
    await page.setViewportSize({ width: 320, height: 850 });
    await openHome(page, lang);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await page.getByRole('button', { name: dashboardStrings[lang].useLocation, exact: true }).click();
    const nearby = page.locator('.near-me'), title = page.getByRole('heading', { level: 1 });
    await expect(nearby.locator('.results li')).toHaveCount(2);
    await page.locator('.find-stop-towns .city-choice').first().click();
    await expect(nearby).toBeHidden();
    await page.getByRole('button', { name: t.cityPicker.changeCity, exact: true }).click();
    await expect(title).toBeFocused();
    await expect(nearby.locator('.results li')).toHaveCount(2);
    expect(await calls()).toBe(1);
    await nearby.locator('.stop-choice').first().click();
    await expect(title).toHaveText('Maple Ave & Main St (to NYC)');
    await expect(nearby).toBeHidden();
    await page.getByRole('button', { name: t.selection.change, exact: true }).click();
    await expect(title).toHaveText(t.findStop);
    await expect(title).toBeFocused();
    await expect(nearby.locator('.results li')).toHaveCount(2);
    expect(await calls()).toBe(1);
    // A new explicit shortcut tap gets its own request and initial nearby focus.
    await page.getByRole('button', { name: t.dash.tabs.dashboard, exact: true }).click();
    expect(await calls()).toBe(1);
    await page.getByRole('button', { name: dashboardStrings[lang].useLocation, exact: true }).click();
    await expect(nearby.getByRole('heading')).toBeFocused();
    await expect(nearby.locator('.results li')).toHaveCount(2);
    expect(await calls()).toBe(2);
  });

  test(`location shortcut shows nearby stops above search without scrolling (${lang})`, async ({ page }) => {
    const t = strings[lang];
    await openHome(page, lang);
    await page.getByRole('button', { name: dashboardStrings[lang].useLocation, exact: true }).click();
    const nearby = page.locator('.near-me'), heading = nearby.getByRole('heading', { name: t.nearMe.button });
    const choices = nearby.getByRole('button', { name: /Maple Ave/ });
    await expect(choices).toHaveCount(2);
    await expect(heading).toBeFocused();
    // toBeVisible alone allows elements below the viewport. Require the full first stop on screen.
    await expect(choices.first()).toBeInViewport({ ratio: 1 });
    const scroll = await page.evaluate(() => scrollY);
    await expect(nearby.getByRole('status')).toHaveText(t.nearMe.results(25));
    expect(await nearby.evaluate(el => !!(el.compareDocumentPosition(document.querySelector('search')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await page.keyboard.press('Tab');
    await expect(nearby.getByRole('button', { name: t.nearMe.button, exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(choices.first()).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(scroll);
    await page.screenshot({ path: `test-results/near-me-shortcut-${lang}.png` });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Maple Ave & Main St (to NYC)');
  });

  test(`nearby stops reflow at 320px and 200% text and remain keyboard reachable (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 850 });
    await openHome(page, lang);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await page.getByRole('button', { name: dashboardStrings[lang].useLocation, exact: true }).click();
    const nearby = page.locator('.near-me');
    await expect(nearby.locator('.results li')).toHaveCount(2);
    await expect(nearby.getByRole('heading')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(nearby.locator('.stop-choice').first()).toBeFocused();
    await expect(nearby.locator('.stop-choice').first()).toBeInViewport();
    const { violations } = await new AxeBuilder({ page }).include('.find-stop-towns').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations.map(v => v.id)).toEqual([]);
    await page.screenshot({ path: `test-results/near-me-shortcut-${lang}-320-200.png` });
  });

  for (const state of ['asking', 'denied', 'failed', 'unsupported'] as const) test(`location shortcut keeps ${state} feedback first (${lang})`, async ({ page }) => {
    await page.addInitScript(state => {
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: state === 'unsupported' ? undefined : {
        getCurrentPosition(_success: PositionCallback, error: PositionErrorCallback) {
          if (state !== 'asking') error({ code: state === 'denied' ? 1 : 2 } as GeolocationPositionError);
        },
      } });
    }, state);
    await openHome(page, lang);
    await page.getByRole('button', { name: dashboardStrings[lang].useLocation, exact: true }).click();
    const nearby = page.locator('.near-me');
    await expect(nearby.getByRole('heading')).toBeFocused();
    await expect(nearby.getByRole('status')).toHaveText(strings[lang].nearMe[state]);
    await expect(nearby.getByRole('status')).toBeInViewport({ ratio: 1 });
    expect(await nearby.evaluate(el => !!(el.compareDocumentPosition(document.querySelector('search')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  });

  test(`plain Find a stop keeps search first without asking for location (${lang})`, async ({ page }) => {
    await openHome(page, lang);
    await page.getByRole('button', { name: strings[lang].findStop, exact: true }).click();
    const nearby = page.locator('.near-me');
    await expect(nearby.getByRole('status')).toBeEmpty();
    await expect(nearby.getByRole('heading')).toHaveCount(0);
    expect(await nearby.evaluate(el => !!(el.compareDocumentPosition(document.querySelector('search')!) & Node.DOCUMENT_POSITION_PRECEDING))).toBe(true);
  });
}
