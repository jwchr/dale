import { test, expect, type Page } from '@playwright/test';
import { openSettings } from './settingsNav';
import AxeBuilder from '@axe-core/playwright';
import { liveDataset, NOW } from '../helpers/liveBus';
import { strings } from '../../src/ui/i18n';
import type { Skin } from '../../src/ui/SkinBackdrop';

test.use({ serviceWorkers: 'block' });
const API = 'https://dale-live.test.workers.dev';
async function setup(page: Page, lang: 'en' | 'es', enabled = false, skin = 'clean') {
  await page.clock.install({ time: NOW });
  await page.addInitScript(({ lang, enabled, skin }) => {
    if (!sessionStorage.getItem('bilingual-seeded')) {
      localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin, theme: 'light', bilingualButtons: enabled }));
      localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'bilingual', label: 'My trip', fromStopId: '2', toStopId: '3', routeIds: ['10'] }]));
      sessionStorage.setItem('bilingual-seeded', '1');
    }
  }, { lang, enabled, skin });
  for (const path of ['/v1/live?**', '/v1/departures?**', '/v1/geometry?**']) await page.route(API + path, r => r.abort('failed'));
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: liveDataset }));
  await page.goto('/?live=1'); await expect(page.locator('.dep').first()).toBeVisible();
}

for (const lang of ['en', 'es'] as const) {
  const t = strings[lang], second = lang === 'en' ? 'es' : 'en', other = strings[second];
  test(`helper is optional, remembered, reverses language order, and turns off (${lang})`, async ({ page }) => {
    await setup(page, lang);
    const before = await page.evaluate(() => localStorage.getItem('arriba.favorites.v1.g2'));
    await expect(page.locator('.bilingual-button-label')).toHaveCount(0);
    await openSettings(page, t, 'more');
    const group = page.getByRole('group', { name: t.bilingualButtons.title });
    await expect(group.getByRole('button', { name: t.bilingualButtons.off })).toHaveAttribute('aria-pressed', 'true');
    const enable = group.getByRole('button', { name: t.bilingualButtons.on });
    await enable.focus(); await page.keyboard.press('Enter'); await expect(enable).toBeFocused();
    await expect(enable).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('arriba.settings.v1')!).bilingualButtons)).toBe(true);
    await page.getByRole('button', { name: t.back, exact: true }).click(); // More settings -> Settings
    await page.getByRole('button', { name: t.back, exact: true }).click(); // Settings -> Home
    const find = page.getByRole('button', { name: `${t.findStop} ${other.findStop}`, exact: true });
    await expect(find.locator('.bilingual-button-label > span')).toHaveText(t.findStop);
    await expect(find.locator('small')).toHaveText(other.findStop); await expect(find.locator('small')).toHaveAttribute('lang', second);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await page.reload(); await expect(find).toBeVisible();
    await page.getByRole('button', { name: t.dash.tabs.household, exact: true }).click();
    await page.getByRole('button', { name: second === 'es' ? 'Español' : 'English', exact: true }).click();
    await page.getByRole('button', { name: other.back, exact: true }).click();
    const reversed = page.getByRole('button', { name: `${other.findStop} ${t.findStop}`, exact: true });
    await expect(reversed.locator('small')).toHaveAttribute('lang', lang);
    await openSettings(page, other, 'more');
    await page.getByRole('group', { name: other.bilingualButtons.title }).getByRole('button', { name: other.bilingualButtons.off }).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('arriba.settings.v1')!).bilingualButtons)).toBe(false);
    await page.getByRole('button', { name: other.back, exact: true }).click(); // More settings -> Settings
    await page.getByRole('button', { name: other.back, exact: true }).click(); // Settings -> Home
    await expect(page.locator('.bilingual-button-label')).toHaveCount(0);
    await expect(page.getByRole('button', { name: other.findStop, exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('arriba.favorites.v1.g2'))).toBe(before);
  });

  test(`translated primary controls keep exact trip and one action per click (${lang})`, async ({ page }) => {
    await setup(page, lang, true);
    const favorites = await page.evaluate(() => localStorage.getItem('arriba.favorites.v1.g2'));
    await page.getByRole('button', { name: `${t.stopSign.open} ${other.stopSign.open}`, exact: true }).click();
    await expect(page.locator('.stop-sign h3')).toHaveText(t.stopSign.title);
    await expect(page.locator('.stop-sign h3')).not.toContainText(other.stopSign.title);
    await page.getByRole('button', { name: `${t.stopSign.open} ${other.stopSign.open}`, exact: true }).click();
    await page.getByRole('button', { name: /7:20/ }).first().click();
    await page.getByRole('button', { name: `${t.lockBus} ${other.lockBus}`, exact: true }).click();
    const read = () => page.evaluate(() => JSON.parse(localStorage.getItem('arriba.lock.v1.g2')!));
    await expect.poll(async () => (await read())?.dep?.tripInstanceId).toBe('T1@20261104');
    await page.getByRole('button', { name: `${t.busLock.begin} ${other.busLock.begin}`, exact: true }).click();
    await expect.poll(async () => (await read()).session.phase).toBe('waiting');
    await page.setViewportSize({ width: 320, height: 850 });
    await page.addStyleTag({ content: 'html { font-size: 200% !important; } body { font-size: 32px !important; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include('.bus-lock').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
    await page.getByRole('button', { name: `${t.busLock.arrived} ${other.busLock.arrived}`, exact: true }).click();
    await expect.poll(async () => (await read()).session.phase).toBe('arrived');
    await page.getByRole('button', { name: `${t.busLock.boarded} ${other.busLock.boarded}`, exact: true }).click();
    await expect.poll(async () => (await read()).session.phase).toBe('onboard');
    const state = await read(); expect(state.dep.tripInstanceId).toBe('T1@20261104');
    expect(state.session.reports.filter((r: { kind: string }) => r.kind === 'arrived')).toHaveLength(1);
    expect(state.session.reports.filter((r: { kind: string }) => r.kind === 'boarded')).toHaveLength(1);
    const ride = page.getByRole('dialog');
    // Use a wide system font as well: Mac and Linux fallback metrics differ.
    await page.addStyleTag({ content: '.ride-top { font-family: monospace; }' });
    for (const width of [305, 320]) {
      await page.setViewportSize({ width, height: 850 });
      expect(await ride.locator('.ride-top').evaluate(row => {
        const title = row.querySelector('h3')!.getBoundingClientRect();
        const exit = row.querySelector('button')!.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        const separate = title.bottom <= exit.top + 1 || exit.bottom <= title.top + 1 || title.right <= exit.left + 1 || exit.right <= title.left + 1;
        return separate && bounds.right <= innerWidth + 1 && exit.left >= bounds.left - 1 && exit.right <= bounds.right + 1 && row.scrollWidth <= row.clientWidth + 1;
      })).toBe(true);
    }
    await ride.locator('.ride-top').screenshot({ path: `test-results/bilingual-full-screen-header-${lang}.png` });
    await page.getByRole('button', { name: `${t.ride.exitFull} ${other.ride.exitFull}`, exact: true }).click();
    await page.getByRole('button', { name: `${t.busLock.stopRide} ${other.busLock.stopRide}`, exact: true }).click();
    // Existing terminal-session contract removes the resumable lock instead of persisting "ended".
    await expect.poll(read).toBeNull();
    await expect(page.locator('.lock-phase')).toHaveText(t.busLock.phase.ended);
    expect(await page.evaluate(() => localStorage.getItem('arriba.favorites.v1.g2'))).toBe(favorites);
  });

  const skins: readonly Skin[] = ['household', 'garden', 'turnpike', 'parkway', 'nyc', 'clean'];
  for (const skin of skins) test(`both label lines fit phone and enlarged text (${lang}, ${skin})`, async ({ page }) => {
    await setup(page, lang, true, skin);
    for (const width of [305, 320]) {
      await page.setViewportSize({ width, height: 850 });
      await page.addStyleTag({ content: 'html { font-size: 200% !important; } body { font-size: 32px !important; }' });
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
      for (const label of await page.locator('.bilingual-button-label').all()) {
        await expect(label.locator('> span')).toHaveAttribute('lang', lang);
        await expect(label.locator('> small')).toHaveAttribute('lang', second);
        const button = label.locator('xpath=ancestor::button[1]'); await button.focus(); await expect(button).toBeFocused();
        const bounds = await button.boundingBox(); expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(await label.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
        // A word that fits the phone must not be split into an orphan letter by a narrow button.
        const split = await label.evaluate(element => {
          const words: string[] = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) for (const word of node.textContent!.matchAll(/\S+/g)) {
            const range = document.createRange(); range.setStart(node, word.index!); range.setEnd(node, word.index! + word[0].length);
            if ([...range.getClientRects()].filter(rect => rect.width > 0).length > 1) words.push(word[0]);
          }
          return words;
        });
        expect(split).toEqual([]);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const overlaps = await page.locator('.home-toolbar button, .home-toolbar > .find-stop, .commute-controls button').evaluateAll(buttons => {
        const boxes = buttons.map(button => button.getBoundingClientRect());
        return boxes.some((a, i) => boxes.some((b, j) => j > i && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
      });
      expect(overlaps).toBe(false);
    }
    expect((await new AxeBuilder({ page }).include('.home-toolbar').include('.commute-controls').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    if (skin === 'garden') {
      await page.screenshot({ path: `test-results/bilingual-buttons-${lang}-320px-200percent.png`, fullPage: true });
      await page.locator('.home-toolbar').screenshot({ path: `test-results/bilingual-toolbar-${lang}.png` });
      await page.locator('.commute-controls').screenshot({ path: `test-results/bilingual-trip-buttons-${lang}.png` });
    }
  });
}

test('remembered helper also works on the schedule-error controls', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: 'es', bilingualButtons: true })));
  await page.route(API + '/v1/schedule', r => r.abort('failed'));
  await page.goto('/?live=1');
  await expect(page.getByRole('button', { name: `${strings.es.retry} ${strings.en.retry}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `${strings.es.journey.trainMode} ${strings.en.journey.trainMode}`, exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
});

test('blocked preference storage keeps the helper usable for this page only', async ({ page }) => {
  await page.addInitScript(() => { Storage.prototype.getItem = () => { throw Error('Synthetic refusal'); }; Storage.prototype.setItem = () => { throw Error('Synthetic refusal'); }; });
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await openSettings(page, strings.en, 'more');
  await page.getByRole('button', { name: strings.en.bilingualButtons.on, exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click(); // More settings -> Settings
  await page.getByRole('button', { name: 'Back', exact: true }).click(); // Settings -> Home
  await expect(page.getByRole('button', { name: `${strings.en.findStop} ${strings.es.findStop}`, exact: true })).toBeVisible();
  await page.reload(); await expect(page.locator('.bilingual-button-label')).toHaveCount(0);
  await expect(page.getByRole('button', { name: strings.en.findStop, exact: true })).toBeVisible();
});
