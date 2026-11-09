import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { strings } from '../../src/ui/i18n';
import { liveDataset, NOW } from '../helpers/liveBus';
const API = 'https://dale-live.test.workers.dev';
test.use({ serviceWorkers: 'block', viewport: { width: 320, height: 780 } });

for (const lang of ['en', 'es'] as const) test(`phone Bus/Train switch retains favorites, lock and checklist with keyboard (${lang})`, async ({ page }) => {
  const t = strings[lang], j = t.journey;
  await page.clock.install({ time: NOW });
  await page.addInitScript(language => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: language, skin: 'clean', theme: 'light' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'first', fromStopId: '2', toStopId: '3', routeIds: [], label: 'My commute' }]));
    // A pre-existing bus checklist must survive entering the separate rail guidance.
    localStorage.setItem('arriba.penn-guide.v1', JSON.stringify({ station: 'essex', direction: 'return', mode: 'bus', travelling: true, step: 3, walks: { summit: 8 } }));
  }, lang);
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: liveDataset }));
  await page.route(API + '/v1/departures?**', r => r.abort('failed'));
  await page.route(API + '/v1/live?**', r => r.abort('failed'));
  await page.goto('/?live=1');
  const modes = page.getByRole('navigation', { name: j.compare });
  await expect(modes.getByRole('button', { name: j.busMode, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.penn-open')).toHaveCount(0);
  const favorites = await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!));
  await page.locator('.dep').first().click();
  await page.getByRole('button', { name: t.lockBus, exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('arriba.lock.v1.g2'))).not.toBeNull();
  const locked = await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.lock.v1.g2')!));
  await page.getByRole('button', { name: t.back, exact: true }).click();
  const train = modes.getByRole('button', { name: j.trainMode, exact: true });
  await train.focus(); await page.keyboard.press('Enter');
  await expect(train).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(t.rail.notice, { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: j.station, exact: true }).selectOption('essex');
  await page.locator('.journey-checklist > summary').click();
  await page.getByRole('button', { name: j.next, exact: true }).click();
  const bus = modes.getByRole('button', { name: j.busMode, exact: true });
  await bus.focus(); await page.keyboard.press('Space');
  await expect(page.locator('.dep').first()).toBeVisible();
  await expect(bus).toHaveAttribute('aria-pressed', 'true');
  await train.click();
  await expect(page.getByRole('combobox', { name: j.station, exact: true })).toHaveValue('essex');
  await expect(page.getByText(j.step(2, 5), { exact: true })).toBeVisible();
  // Loading normalizes object key order; every saved value and the array order must survive.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toEqual(favorites);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.lock.v1.g2')!))).toMatchObject({
    dep: locked.dep, leg: locked.leg, session: { id: locked.session.id, phase: locked.session.phase,
      lock: { tripInstanceId: locked.session.lock.tripInstanceId, lockedAt: locked.session.lock.lockedAt } },
  });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.penn-guide.v1.bus')!))).toMatchObject({ mode: 'bus', step: 3, travelling: true });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/travel-mode-${lang}.png`, fullPage: true });
  await page.goBack();
  await expect(bus).toHaveAttribute('aria-pressed', 'true');
  await train.click();
  await expect(page.getByText(j.step(2, 5), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(t.busLock.resume) }).click();
  await expect(page.locator('.bus-lock')).toBeVisible();
});

test('checklist survives switching with storage blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  await page.goto('/?now=2026-11-04T07:50&demo');
  const j = strings.en.journey;
  await page.getByRole('button', { name: j.trainMode, exact: true }).click();
  await page.locator('.journey-checklist > summary').click();
  await page.getByRole('button', { name: j.next, exact: true }).click();
  await page.getByRole('button', { name: j.busMode, exact: true }).click();
  await page.getByRole('button', { name: j.trainMode, exact: true }).click();
  await expect(page.getByText(j.step(2, 5), { exact: true })).toBeVisible();
});
