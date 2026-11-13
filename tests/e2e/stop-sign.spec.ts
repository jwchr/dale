import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { liveDataset, NOW } from '../helpers/liveBus';
import { strings } from '../../src/ui/i18n';
import { signRowPlacement, STOP_SCENES } from '../../src/domain/stopSign';

test.use({ serviceWorkers: 'block', viewport: { width: 305, height: 780 } });
const API = 'https://dale-live.test.workers.dev';
for (const lang of ['en', 'es'] as const) test(`illustrative seasonal sign loads only chosen art and preserves trip (${lang})`, async ({ page }) => {
  const t = strings[lang];
  const ds = structuredClone(liveDataset);
  ds.stops.find(s => s.id === '2')!.code = '00123';
  const favorites = [{ id: 'home', fromStopId: '2', toStopId: '3', routeIds: [], label: 'My saved trip' }];
  await page.addInitScript(({ lang, favorites }) => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'garden', theme: 'light' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify(favorites));
  }, { lang, favorites });
  await page.clock.install({ time: NOW });
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', route => route.fulfill({ json: ds }));
  await page.route(API + '/v1/departures?**', route => route.abort('failed'));
  const images: string[] = [];
  page.on('request', request => { if (/\/(spring|summer|autumn|winter)-[^/]+\.webp/.test(request.url())) images.push(request.url()); });
  await page.goto('/?live=1');
  await expect(page.locator('.dep').first()).toBeVisible();
  expect(images).toEqual([]);
  const sign = page.locator('.stop-sign');
  await page.getByRole('button', { name: t.stopSign.open, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: t.stopSign.open, exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(sign.locator('img')).toHaveJSProperty('complete', true);
  await expect(sign.locator('.stop-sign-number')).toHaveText('00123');
  const rows = sign.locator('.stop-sign-row');
  await expect(rows).toHaveCount(await sign.locator('.stop-sign-route-tags strong').count());
  await expect(rows.first()).toHaveText(/^\S+ To New York$/);
  await expect(sign).not.toContainText('13583');
  await expect(sign).not.toContainText('707');
  await expect(sign.locator('figcaption')).toHaveText(t.stopSign.illustration);
  await expect(sign.locator('img')).toHaveAttribute('src', /autumn-clear/);
  expect(images).toHaveLength(1);
  if (lang === 'en') {
    for (const scene of STOP_SCENES) {
      await sign.getByRole('combobox', { name: t.stopSign.artwork }).selectOption(scene);
      await expect(sign.locator('img')).toHaveAttribute('src', new RegExp(scene));
      await expect(sign.locator('img')).toHaveJSProperty('complete', true);
      expect(await sign.locator('img').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(340);
      // The lettering layer covers exactly the photo, so every line lands on the sign's ruled rows.
      expect(await sign.locator('.stop-sign-art').evaluate(node => {
        const image = node.querySelector('img')!.getBoundingClientRect(), svg = node.querySelector('svg')!.getBoundingClientRect();
        return [image.x - svg.x, image.y - svg.y, image.width - svg.width, image.height - svg.height].every(d => Math.abs(d) < 1);
      })).toBe(true);
      await sign.screenshot({ path: `test-results/stop-sign-${scene}.png` });
    }
  }
  expect((await new AxeBuilder({ page }).include('.stop-sign').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await sign.screenshot({ path: `test-results/stop-sign-${lang}-large.png` });
  await page.route('**/winter-snow-*.webp', route => route.abort('failed'));
  // Pick a not-yet-loaded URL in Spanish; English's selected variant is already cached.
  if (lang === 'es') {
    await sign.getByRole('combobox', { name: t.stopSign.artwork }).selectOption('winter-snow');
    await expect(sign.getByRole('status')).toHaveText(t.stopSign.failed);
    await expect(sign.locator('img')).toHaveCount(0);
    await expect(sign.locator('.stop-sign-face')).toBeVisible();
    await expect(sign.locator('.stop-sign-face-number')).toHaveText('00123');
  }
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toEqual(favorites);
  await page.getByRole('button', { name: t.stopSign.open, exact: true }).click();
  await expect(sign.locator('img')).toHaveCount(0);
  await expect(page.locator('.dep').first()).toBeVisible();
});

test('missing public stop number never substitutes the internal stop ID', async ({ page }) => {
  const ds = structuredClone(liveDataset);
  delete ds.stops.find(s => s.id === '2')!.code;
  await page.addInitScript(() => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: 'en', skin: 'clean' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'home', fromStopId: '2', toStopId: '3', routeIds: [], label: 'My trip' }]));
  });
  await page.clock.install({ time: NOW });
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', route => route.fulfill({ json: ds }));
  await page.route(API + '/v1/departures?**', route => route.abort('failed'));
  await page.goto('/?live=1');
  await expect(page.locator('.dep').first()).toBeVisible();
  await page.getByRole('button', { name: strings.en.stopSign.open, exact: true }).click();
  await expect(page.locator('.stop-sign-number')).toHaveText('—');
});


test('physical sign wording stays printed when surrounding UI changes language', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: 'en', skin: 'clean' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'home', fromStopId: '2', toStopId: '3', routeIds: [], label: 'My trip' }]));
  });
  await page.clock.install({ time: NOW });
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: liveDataset }));
  await page.route(API + '/v1/departures?**', r => r.abort('failed'));
  await page.goto('/?live=1');
  await page.getByRole('button', { name: strings.en.stopSign.open, exact: true }).click();
  const lettering = page.locator('.stop-sign-art svg');
  await expect(lettering).toContainText('To New York');
  const physical = await lettering.textContent();
  await expect(page.locator('.stop-sign-face')).toBeHidden();
  await page.getByRole('button', { name: strings.en.settings, exact: true }).click();
  await page.getByRole('button', { name: 'Español', exact: true }).click();
  await page.getByRole('button', { name: strings.es.back, exact: true }).click();
  await page.getByRole('button', { name: strings.es.stopSign.open, exact: true }).click();
  await expect(page.locator('.stop-sign h3')).toHaveText(strings.es.stopSign.title);
  expect(await lettering.textContent()).toBe(physical);
});

test('a long sign line stays squeezed onto its ruled row when fonts load again', async ({ page }) => {
  const ds = structuredClone(liveDataset);
  const to = ds.stops.find(s => s.id === '3')!;
  delete to.terminal;
  to.name = 'Hackensack Bus Terminal Lane 12 Platform B at River Street';
  await page.addInitScript(() => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: 'en', skin: 'clean' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'home', fromStopId: '2', toStopId: '3', routeIds: [], label: 'My trip' }]));
  });
  await page.clock.install({ time: NOW });
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: ds }));
  await page.route(API + '/v1/departures?**', r => r.abort('failed'));
  await page.goto('/?live=1');
  await page.getByRole('button', { name: strings.en.stopSign.open, exact: true }).click();
  const row = page.locator('.stop-sign-row').first();
  await expect(row).toHaveAttribute('textLength', String(signRowPlacement(0).maxWidth));
  // Measuring an already-squeezed line again must keep the squeeze.
  for (let i = 0; i < 2; i++) await page.evaluate(() => document.fonts.dispatchEvent(new Event('loadingdone')));
  await expect(row).toHaveAttribute('textLength', String(signRowPlacement(0).maxWidth));
  const fits = await page.locator('.stop-sign-art').evaluate(art => {
    const svg = art.querySelector('svg')!, text = art.querySelector('.stop-sign-row') as SVGTextElement;
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    return text.getBoundingClientRect().right <= svg.getBoundingClientRect().left + 680 * scale - 395 * scale;
  });
  expect(fits).toBe(true);
});
