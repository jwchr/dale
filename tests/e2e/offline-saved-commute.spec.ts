import { expect, test } from '@playwright/test';
import { strings } from '../../src/ui/i18n';
import { preview, type PreviewServer } from 'vite';

// Exercise Chromium's real service worker, Cache API and offline navigation together.
// The published printed fixture is served locally; there is no live API or rider data.
test.use({ serviceWorkers: 'allow' });
let server: PreviewServer, origin: string;
test.beforeAll(async () => {
  // Vite's default development CORS middleware adds Vary: Origin. Its worker
  // precache (no Origin header) then cannot answer module/CSS requests carrying
  // Origin while offline. Use production-style same-origin static serving here.
  server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0, cors: false } });
  origin = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => { if (server) await new Promise<void>(resolve => server.httpServer.close(() => resolve())); });

for (const lang of ['en', 'es'] as const) test(`saved commute and last schedule reopen fully offline (${lang})`, async ({ page, context }) => {
  const t = strings[lang];
  await page.addInitScript(language => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: language, skin: 'clean' }));
  }, lang);
  await page.goto(origin + '?printed=1&now=2026-11-04T07:50');
  await page.getByRole('button', { name: t.findStop, exact: true }).first().click();
  await page.getByRole('searchbox').fill('irvington');
  await page.getByRole('button', { name: /Irvington St\. \(to New York\)/ }).click();
  await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
  await page.getByRole('button', { name: t.selection.save, exact: true }).first().click();
  await expect(page.locator('.fav')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => !!localStorage.getItem('arriba.favorites.v1'))).toBe(true);
  const before = await page.evaluate(() => localStorage.getItem('arriba.favorites.v1'));
  expect(before).toBeTruthy();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    });
  });
  await expect.poll(() => page.evaluate(async () => !!await caches.match(new URL('data/corridor.json', location.href).href))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.fav')).toHaveCount(1);
  await expect(page.locator('.fav')).toContainText('Irvington');
  await expect(page.getByRole('status').filter({ hasText: lang === 'en' ? 'Offline.' : 'Sin conexión.' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('arriba.favorites.v1'))).toBe(before);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await page.locator('.dep').first().click();
  await expect(page.locator('.trip-ticket')).toBeVisible();
});
