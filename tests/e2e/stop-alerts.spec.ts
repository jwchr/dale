import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { strings } from '../../src/ui/i18n';

test.use({ serviceWorkers: 'block' });

// Stop alerts (#176): the phone's voice and notifications are replaced with recorders, so the test sees
// exactly what would be said and shown. Sound itself is not audible in a headless browser.
async function recordOutputs(page: Page, opts: { iphoneWithoutNotifications?: boolean; deny?: boolean } = {}) {
  await page.addInitScript((o) => {
    const w = window as unknown as Record<string, unknown>;
    w.__spoken = []; w.__notes = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak: (u: SpeechSynthesisUtterance) => { if (u.text) (w.__spoken as unknown[]).push({ text: u.text, lang: u.lang }); },
      cancel: () => {},
    } });
    if (o.iphoneWithoutNotifications) {
      delete (window as unknown as { Notification?: unknown }).Notification;
      Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1' });
      return;
    }
    class FakeNotification {
      static permission: NotificationPermission = 'default';
      static requestPermission() { FakeNotification.permission = o.deny ? 'denied' : 'granted'; return Promise.resolve(FakeNotification.permission); }
      constructor(title: string, options?: NotificationOptions) { (w.__notes as unknown[]).push({ title, body: options?.body }); }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification });
  }, opts);
}

async function board(page: Page, lang: 'en' | 'es') {
  const t = strings[lang];
  await page.addInitScript((l) => localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: l, skin: 'clean', theme: 'light' })), lang);
  await page.goto('/?now=2026-11-04T07:50&demo');
  await page.getByRole('button', { name: t.findStop, exact: true }).first().click();
  await page.getByRole('searchbox').fill('90002');
  await page.getByRole('button', { name: /Maple Ave & Main St \(to NYC\)/ }).click();
  await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
  await page.getByRole('button', { name: t.selection.save, exact: true }).first().click();
  await page.locator('.dep').first().click();
  await page.getByRole('button', { name: t.lockBus, exact: true }).click();
  await page.getByRole('button', { name: t.busLock.begin, exact: true }).click();
  await page.getByRole('button', { name: t.busLock.arrived, exact: true }).click();
  await page.getByRole('button', { name: t.busLock.boarded, exact: true }).click();
  return page.getByRole('dialog');
}

const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: { text: string; lang: string }[] }).__spoken);
const notes = (page: Page) => page.evaluate(() => (window as unknown as { __notes: { title: string; body: string }[] }).__notes);

for (const lang of ['en', 'es'] as const) test(`stop alerts speak and notify once per step, never on opening (${lang})`, async ({ page }) => {
  const r = strings[lang].ride, dest = 'Port Authority Bus Terminal';
  await recordOutputs(page);
  const ride = await board(page, lang);
  await ride.getByRole('checkbox', { name: r.sound }).check();
  await ride.getByRole('checkbox', { name: r.notify }).check();
  await expect(ride.getByRole('checkbox', { name: r.notify })).toBeChecked();
  expect(await spoken(page)).toEqual([]); // turning it on says nothing by itself
  await ride.getByRole('button', { name: r.soundTest }).click();
  expect(await spoken(page)).toEqual([{ text: r.stopsTo(3, dest), lang: lang === 'es' ? 'es-US' : 'en-US' }]);
  expect(await notes(page)).toEqual([]); // the test is sound only

  const move = ride.getByRole('button', { name: r.demoNext });
  await move.click();
  await expect(ride.locator('.ride-message')).toHaveText(r.stopsTo(2, dest));
  await move.click();
  await expect(ride.locator('.ride-message')).toHaveText(r.lastNext(dest));
  await move.click();
  await expect(ride.locator('.ride-message')).toHaveText(r.arrived(dest));
  // Two alerts: 2 stops and "next stop is yours". Arriving is on screen only.
  expect((await spoken(page)).slice(1).map((s) => s.text)).toEqual([r.stopsTo(2, dest), r.lastNext(dest)]);
  expect(await notes(page)).toEqual([{ title: r.notifyTitle, body: r.stopsTo(2, dest) }, { title: r.notifyTitle, body: r.lastNext(dest) }]);
  // The settings stay for the next ride.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.ride.v1')!))).toMatchObject({ sound: true, notify: true });
});

test('opening ride mode mid-countdown does not alert, and alerts stay off unless chosen', async ({ page }) => {
  const r = strings.en.ride;
  await recordOutputs(page);
  const ride = await board(page, 'en');
  await ride.getByRole('button', { name: r.demoNext }).click();
  await ride.getByRole('button', { name: r.demoNext }).click();
  expect(await spoken(page)).toEqual([]);
  expect(await notes(page)).toEqual([]);
  await expect(ride.getByRole('checkbox', { name: r.sound })).not.toBeChecked();
  await expect(ride.getByRole('checkbox', { name: r.notify })).not.toBeChecked();
});

test('blocked notifications and iPhone without Home Screen say why, and stay off', async ({ page, browser }) => {
  const r = strings.en.ride;
  await recordOutputs(page, { deny: true });
  let ride = await board(page, 'en');
  await ride.getByRole('checkbox', { name: r.notify }).click();
  await expect(ride.getByRole('checkbox', { name: r.notify })).not.toBeChecked();
  await expect(ride.getByRole('status').filter({ hasText: r.notifyBlocked })).toBeVisible();

  const iphone = await browser.newPage();
  await recordOutputs(iphone, { iphoneWithoutNotifications: true });
  ride = await board(iphone, 'en');
  await ride.getByRole('checkbox', { name: r.notify }).click();
  await expect(ride.getByRole('checkbox', { name: r.notify })).not.toBeChecked();
  await expect(ride.getByRole('status').filter({ hasText: r.notifyIphone })).toBeVisible();
  await iphone.close();
});

for (const lang of ['en', 'es'] as const) test(`alert settings fit a narrow phone at 200% text and pass accessibility (${lang})`, async ({ page }) => {
  const r = strings[lang].ride;
  await recordOutputs(page);
  const ride = await board(page, lang);
  await ride.getByRole('checkbox', { name: r.sound }).check();
  for (const width of [305, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    for (const name of [r.sound, r.notify]) {
      const box = (await ride.getByRole('checkbox', { name }).locator('xpath=..').boundingBox())!;
      expect(box.x + box.width, `${lang} ${width}px: ${name}`).toBeLessThanOrEqual(width);
    }
    const test = (await ride.getByRole('button', { name: r.soundTest }).boundingBox())!;
    expect(test.x + test.width).toBeLessThanOrEqual(width);
    expect(test.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  const { violations } = await new AxeBuilder({ page }).include('.ride-full').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  // Keyboard: the test button is reachable and works with Enter.
  await ride.getByRole('button', { name: r.soundTest }).focus();
  await page.keyboard.press('Enter');
  expect((await spoken(page)).at(-1)?.text).toBe(r.stopsTo(3, 'Port Authority Bus Terminal'));
});

for (const lang of ['en', 'es'] as const) test(`a saved "sound on" asks for one tap until the page may play sound (${lang})`, async ({ page }) => {
  const r = strings[lang].ride;
  await recordOutputs(page);
  await page.addInitScript(() => localStorage.setItem('arriba.ride.v1', JSON.stringify({ sound: true })));
  const ride = await board(page, lang);
  await expect(ride.getByRole('checkbox', { name: r.sound })).toBeChecked();
  const note = ride.getByRole('status').filter({ hasText: r.soundTap });
  await expect(note).toBeVisible();
  await ride.locator('h3').first().click();
  await expect(note).toHaveCount(0);
});
