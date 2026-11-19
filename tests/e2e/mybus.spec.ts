import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { liveDataset, NOW } from '../helpers/liveBus';
import { myBusStrings } from '../../src/ui/myBusStrings';
import { LIVE_SOURCE } from '../../src/domain/liveBus';
import type { Lang } from '../../src/ui/i18n';
import type { Skin } from '../../src/ui/SkinBackdrop';
const skins: readonly Skin[] = ['household', 'garden', 'turnpike', 'parkway', 'nyc', 'clean'];

test.use({ serviceWorkers: 'block' });
const API = 'https://dale-live.test.workers.dev';
async function setup(page: Page, { lang = 'en', skin = 'clean', code = '00302', phone = 'android', denied = false, fallback = false } = {}) {
  const ds = structuredClone(liveDataset);
  ds.stops.find(s => s.id === '2')!.code = code;
  await page.clock.install({ time: NOW });
  await page.addInitScript(({ lang, skin, phone, denied, fallback }) => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin, theme: 'light', count: 3 }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'mybus', label: 'Fixture commute', fromStopId: '2', toStopId: '3', routeIds: ['10'] }]));
    Object.defineProperty(navigator, 'userAgent', { value: phone === 'apple' ? 'iPhone' : phone === 'android' ? 'Android' : 'Desktop' });
    Object.defineProperty(navigator, 'platform', { value: phone === 'apple' ? 'iPhone' : 'Linux' });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => {
      const state = window as unknown as { copies: string[] };
      state.copies.push(value);
      if (denied) throw new Error('Synthetic permission refusal');
    } } });
    (window as unknown as { copies: string[] }).copies = [];
    if (fallback) delete (window as unknown as { CommandEvent?: unknown }).CommandEvent;
  }, { lang, skin, phone, denied, fallback });
  for (const path of ['/v1/live?**', '/v1/departures?**', '/v1/geometry?**']) await page.route(API + path, r => r.abort('failed'));
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: ds }));
  await page.goto('/?live=1');
  await page.getByRole('button', { name: /7:20/ }).first().click();
  await page.getByRole('button', { name: lang === 'en' ? 'Lock onto this bus' : 'Seguir este autobús', exact: true }).click();
  const panel = page.getByTestId('mybus-fallback');
  await expect(panel).not.toHaveAttribute('open');
  await panel.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(panel).toHaveAttribute('open', '');
  return panel;
}
const copies = (page: Page) => page.evaluate(() => (window as unknown as { copies: string[] }).copies);
const lock = (page: Page) => page.evaluate(() => localStorage.getItem('arriba.lock.v1.g2'));

test('an open lookup and focused control survive missing → fresh → missing GPS', async ({ page }) => {
  const panel = await setup(page);
  const copy = panel.getByRole('button', { name: myBusStrings.en.copy });
  await copy.focus();
  await page.route(API + '/v1/live?**', route => route.fulfill({ json: {
    v: 1, source: LIVE_SOURCE, feedVersion: liveDataset.meta.feedVersion, tripInstanceId: 'T1@20261104', receivedAt: NOW + 31_000,
    vehicles: { state: 'ok', timestamp: NOW + 30_000 }, updates: { state: 'ok', timestamp: NOW + 30_000 },
    observations: [{ tripInstanceId: 'T1@20261104', vehicleId: 'bus-A', observedAt: NOW + 30_000, lat: 40.89, lon: -74.04 }],
    predictions: [], skippedStops: [],
  } }));
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('live-bus-status')).toContainText('LIVE REPORT');
  await expect(panel).toHaveAttribute('open', ''); await expect(copy).toBeFocused();
  await page.route(API + '/v1/live?**', route => route.abort('failed'));
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('live-bus-status')).toContainText('GPS data unavailable');
  await expect(panel).toHaveAttribute('open', ''); await expect(copy).toBeFocused();
  expect(await copies(page)).toEqual([]);
});

for (const lang of ['en', 'es'] as Lang[]) {
  test(`Android handoff copies once, opens only on action, and preserves the bus (${lang})`, async ({ page }) => {
    const t = myBusStrings[lang];
    let officialRequests = 0;
    await page.context().route('https://www.njtransit.com/**', r => { officialRequests++; return r.fulfill({ body: '<title>Synthetic official form</title>' }); });
    const panel = await setup(page, { lang });
    await expect(panel).toContainText('MAIN ST, AT ELM');
    await expect(panel).toContainText('165 NEW YORK');
    await expect(panel.locator('.mybus-code')).toHaveText('00302');
    await expect(panel.getByRole('link', { name: t.draft })).toHaveAttribute('href', 'sms:69287?body=00302');
    await expect(panel).toContainText(t.send); await expect(panel).toContainText(t.rates);
    expect(officialRequests).toBe(0); expect(await copies(page)).toEqual([]);
    await expect.poll(() => lock(page)).not.toBeNull();
    const before = await lock(page);
    const copy = panel.getByRole('button', { name: t.copy });
    await copy.focus(); await page.keyboard.press('Enter');
    await expect(panel.getByRole('status')).toHaveText(t.copied);
    expect(await copies(page)).toEqual(['00302']); await expect(copy).toBeFocused();
    await copy.click(); expect(await copies(page)).toEqual(['00302', '00302']);
    const web = panel.getByRole('link', { name: t.web });
    await expect(web).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(web).toHaveAttribute('referrerpolicy', 'no-referrer');
    const popupPromise = page.waitForEvent('popup'); await web.click();
    const popup = await popupPromise; await popup.waitForLoadState();
    expect(officialRequests).toBe(1); expect(await lock(page)).toBe(before);
    await popup.close();
    await page.clock.fastForward(6100); await expect(panel.getByRole('status')).toBeEmpty();
  });

  test(`copy refusal is visible and retry stays usable (${lang})`, async ({ page }) => {
    const t = myBusStrings[lang], panel = await setup(page, { lang, denied: true, fallback: true });
    const button = panel.getByRole('button', { name: t.copy });
    await button.focus(); await page.keyboard.press('Enter');
    await expect(panel.getByRole('status')).toHaveText(t.failed); await expect(button).toBeFocused();
    expect(await copies(page)).toEqual(['00302']); await expect(button).toBeEnabled();
    await button.click(); expect(await copies(page)).toEqual(['00302', '00302']);
    await expect(panel.locator('.mybus-code')).toHaveText('00302');
  });

  for (const skin of skins) test(`narrow enlarged lookup, keyboard and accessibility (${lang}, ${skin})`, async ({ page }) => {
    await page.setViewportSize({ width: 305, height: 780 });
    const panel = await setup(page, { lang, skin });
    await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
    await page.addStyleTag({ content: 'body { font-size: 32px !important; }' });
    const targets = panel.locator('summary, button, a');
    for (const target of await targets.all()) {
      const box = await target.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
      await target.focus(); await expect(target).toBeFocused();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include('[data-testid="mybus-fallback"]').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    if (skin === 'garden') await panel.screenshot({ path: `test-results/mybus-${lang}-305px-200percent.png` });
  });
}

test('iPhone uses documented recipient-only Messages with copy and paste instructions', async ({ page }) => {
  const t = myBusStrings.en, panel = await setup(page, { phone: 'apple' });
  await expect(panel.getByRole('link', { name: t.messages })).toHaveAttribute('href', 'sms:69287');
  await expect(panel).toContainText(t.paste);
  await panel.getByRole('button', { name: t.copy }).click();
  expect(await copies(page)).toEqual(['00302']);
});

test('desktop keeps the web form and selectable code without a mobile protocol link', async ({ page }) => {
  const panel = await setup(page, { phone: 'desktop' });
  await expect(panel.locator('a[href^="sms:"]')).toHaveCount(0);
  await expect(panel).toContainText(myBusStrings.en.desktop);
  await expect(panel.getByRole('link')).toHaveAttribute('href', 'https://www.njtransit.com/my-bus-to');
});

test('missing published code disables stop-specific actions without inventing an ID', async ({ page }) => {
  const panel = await setup(page, { code: '' });
  await expect(panel).toContainText(myBusStrings.en.missing);
  await expect(panel.getByRole('button', { name: myBusStrings.en.disabled })).toBeDisabled();
  await expect(panel.locator('.mybus-code, a[href^="sms:"]')).toHaveCount(0);
  await expect(panel.getByRole('link')).toHaveAttribute('href', 'https://www.njtransit.com/my-bus-to');
});

test('failed schedule still offers the generic official form in both languages', async ({ page }) => {
  await page.route(API + '/v1/schedule', r => r.abort('failed'));
  await page.goto('/?live=1');
  for (const lang of ['en', 'es'] as const) {
    if (lang === 'es') await page.getByRole('button', { name: 'Español', exact: true }).click();
    const panel = page.getByTestId('mybus-fallback');
    if (!(await panel.evaluate(e => (e as HTMLDetailsElement).open))) await panel.locator('summary').click();
    await expect(panel).toContainText(myBusStrings[lang].missing);
    await expect(panel.getByRole('link')).toHaveAttribute('href', 'https://www.njtransit.com/my-bus-to');
    await expect(panel.locator('a[href^="sms:"]')).toHaveCount(0);
  }
});
