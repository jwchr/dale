import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { liveDataset, NOW } from '../helpers/liveBus';
import { strings } from '../../src/ui/i18n';

const API = 'https://dale-live.test.workers.dev';
test.use({ serviceWorkers: 'block', viewport: { width: 305, height: 780 } });
for (const lang of ['en', 'es'] as const) test(`manual Tour guide has sourced local cards and preserves the locked trip (${lang})`, async ({ page }) => {
  const t = strings[lang];
  await page.clock.install({ time: NOW });
  const outside: string[] = [];
  page.on('request', request => { if (!['localhost', 'dale-live.test.workers.dev'].includes(new URL(request.url()).hostname)) outside.push(request.url()); });
  await page.addInitScript(language => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: language, skin: 'garden', theme: 'light' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'home', fromStopId: '2', toStopId: '3', routeIds: [], label: 'My trip' }]));
  }, lang);
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', route => route.fulfill({ json: liveDataset }));
  await page.route(API + '/v1/departures?**', route => route.abort('failed'));
  await page.route(API + '/v1/live?**', route => route.abort('failed'));
  await page.goto('/?live=1');
  await page.locator('.dep').first().click();
  await page.getByRole('button', { name: t.lockBus, exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('arriba.lock.v1.g2'))).not.toBeNull();
  const before = await page.evaluate(() => ({ favorites: JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!), lock: JSON.parse(localStorage.getItem('arriba.lock.v1.g2')!) }));
  await page.getByRole('button', { name: t.back, exact: true }).click();
  const guide = page.locator('.tour-guide');
  await guide.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(guide).toHaveAttribute('open', '');
  await expect(guide.getByRole('heading', { name: t.tour.title, exact: true })).toBeVisible();
  await expect(guide.getByRole('article')).toHaveCount(5);
  const catalog = guide.getByRole('list');
  await expect(catalog).toHaveAttribute('role', 'list'); // Explicit Safari fallback for markerless grid lists.
  await expect(catalog.getByRole('listitem')).toHaveCount(5);
  const first = guide.getByRole('article').first();
  await expect(first).toContainText(lang === 'en' ? 'militia training' : 'entrenamiento de milicias');
  await expect(guide).toContainText('42 Court Street');
  await expect(guide).toContainText('10 Main Street');
  await expect(guide).toContainText('Richard Varick');
  const library = guide.getByRole('article').filter({ has: page.getByRole('heading', { name: lang === 'en' ? 'Johnson Public Library' : 'Biblioteca Pública Johnson', exact: true }) });
  await expect(library).toContainText('274 Main Street');
  await expect(library).toContainText('1901');
  await expect(library).toContainText(lang === 'en' ? 'parchment-and-quill' : 'pergamino y una pluma');
  await expect(library.getByRole('link')).toHaveAttribute('href', 'https://www.johnsonlib.org/history');
  const arts = guide.getByRole('article').filter({ has: page.getByRole('heading', { name: lang === 'en' ? 'Hackensack Performing Arts Center' : 'Centro de Artes Escénicas de Hackensack', exact: true }) });
  await expect(arts).toContainText('102 State Street');
  await expect(arts).toContainText(lang === 'en' ? 'Masonic' : 'masónico');
  await expect(arts.getByRole('link')).toHaveAttribute('href', 'https://www.dmrarchitects.com/projects/public/hackensack-pac/');
  await expect(library).toContainText(lang === 'en' ? 'Nov 15, 2026' : '15 nov 2026');
  await expect(arts).toContainText(lang === 'en' ? 'Nov 15, 2026' : '15 nov 2026');
  const links = guide.getByRole('link');
  await expect(links).toHaveCount(5);
  for (const link of await links.all()) {
    expect(await link.getAttribute('href')).toMatch(/^https:\/\/(bergencountynj\.gov|npgallery\.nps\.gov|www\.johnsonlib\.org|www\.dmrarchitects\.com)\//);
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAttribute('target', '_blank');
  }
  await links.first().focus(); await expect(links.first()).toBeFocused();
  expect((await new AxeBuilder({ page }).include('.tour-guide').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/tour-guide-${lang}.png`, fullPage: true });
  await guide.locator('summary').focus(); await page.keyboard.press('Space');
  await expect(guide).not.toHaveAttribute('open', '');
  const after = await page.evaluate(() => ({ favorites: JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!), lock: JSON.parse(localStorage.getItem('arriba.lock.v1.g2')!) }));
  expect(after.favorites).toEqual(before.favorites);
  expect(after.lock).toMatchObject({ dep: before.lock.dep, leg: before.lock.leg, session: { id: before.lock.session.id, phase: before.lock.session.phase, lock: { tripInstanceId: before.lock.session.lock.tripInstanceId, lockedAt: before.lock.session.lock.lockedAt } } });
  expect(outside).toEqual([]);
});

test('manual history is available before saving a favorite', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: 'en' }));
    localStorage.setItem('arriba.favorites.v1.g2', '[]');
  });
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', route => route.fulfill({ json: liveDataset }));
  await page.goto('/?live=1');
  await page.locator('.tour-guide summary').click();
  await expect(page.getByRole('heading', { name: strings.en.tour.title, exact: true })).toBeVisible();
  await expect(page.locator('.tour-card')).toHaveCount(5);
});
