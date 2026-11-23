import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error plain ESM script without type declarations
import { buildDataset } from '../../scripts/gtfs-lib.mjs';
// @ts-expect-error plain ESM script without type declarations
import { buildRescueSchedule } from '../../scripts/rescue-schedule.mjs';
import { rescueStrings } from '../../src/ui/rescueStrings';
import { strings } from '../../src/ui/i18n';
import { syntheticGtfs } from '../helpers/syntheticGtfs';

// "Get me home" with the wider official schedule (#32 step 1). Synthetic data only.
const API = 'https://dale-live.test.workers.dev';
const files = syntheticGtfs();
const corridor = buildDataset(files, { routeShortNames: ['163', '164', '165', '165T'], splitVariants: true, feedVersion: 'synthetic01', source: 'NJ Transit GTFS BUS G2', builtAt: '2026-11-19T10:00:00Z' });
corridor.meta.realtime = { provider: 'njt-bus-g2' };
const wider = buildRescueSchedule(files, corridor, { builtAt: '2026-11-19T10:00:00Z' }).schedule;
// Thursday Nov 19, 2026, 6:00 PM Eastern.
const NOW = Date.parse('2026-11-19T23:00:00Z');

async function open(page: Page, lang: 'en' | 'es', extra: 'ok' | 'missing') {
  const asked: string[] = [];
  await page.addInitScript(({ lang }) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'garden', theme: 'light' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'home', label: 'Home', fromStopId: 'S5', toStopId: 'S30', routeIds: [] }]));
  }, { lang });
  await page.clock.install({ time: NOW });
  await page.route(API + '/v1/geometry?**', (r) => r.abort('failed'));
  await page.route(API + '/v1/departures?**', (r) => r.abort('failed'));
  await page.route(API + '/v1/schedule', (r) => { asked.push('schedule'); return r.fulfill({ json: corridor }); });
  await page.route(API + '/v1/schedule?**', (r) => { asked.push(new URL(r.request().url()).search); return extra === 'ok' ? r.fulfill({ json: wider }) : r.fulfill({ status: 404, body: 'Rescue schedule unavailable' }); });
  await page.goto('/');
  return asked;
}

test.use({ serviceWorkers: 'block' });
for (const lang of ['en', 'es'] as const) {
  const t = strings[lang], w = rescueStrings[lang];

  test(`wider routes load only when Get me home opens, labeled scheduled and not tracked (${lang})`, async ({ page }) => {
    const asked = await open(page, lang, 'ok');
    await expect(page.locator('.rescue-chip').first()).toBeVisible();
    expect(asked).toEqual(['schedule']);
    await page.locator('.rescue-chip').first().click();
    const rescue = page.locator('.rescue');
    await expect(rescue).toContainText(w.widerIncluded('166, 167, 168'));
    expect(asked).toEqual(['schedule', '?extra=rescue&feedVersion=synthetic01']);
    await expect(rescue.locator('.rescue-list li', { hasText: w.widerTag }).first()).toBeVisible();
    await expect(rescue.getByRole('heading', { name: w.nearTitle })).toBeVisible();
    await expect(rescue).toContainText(lang === 'en' ? 'Not a verified walk.' : 'No es un camino a pie verificado.');
    await expect(rescue).toContainText(w.walkNote);
    // One change of bus at the same stop, sooner than any direct bus (#32 step 2).
    await expect(rescue.getByRole('heading', { name: w.transfersTitle })).toBeVisible();
    const change = rescue.locator('h2', { hasText: w.transfersTitle }).locator('xpath=following-sibling::ol[1]/li').first();
    await expect(change).toContainText(lang === 'en' ? 'same stop' : 'misma parada');
    await expect(change).toContainText(`165 · ${t.gateTurnpikeExpress}`);
    await expect(rescue).toContainText(t.rescue.coverage(`163, 164, 165, 165 · ${t.gateTurnpikeExpress}, 166, 167, 168`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const { violations } = await new AxeBuilder({ page }).include('.rescue').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations).toEqual([]);
    await page.screenshot({ path: `test-results/rescue-wider-${lang}.png`, fullPage: true });
  });

  test(`says why other routes were not searched when the server does not offer them (${lang})`, async ({ page }) => {
    await open(page, lang, 'missing');
    await page.locator('.rescue-chip').first().click();
    const rescue = page.locator('.rescue');
    await expect(rescue).toContainText(w.missing.not_offered);
    await expect(rescue).toContainText(t.rescue.coverage(`163, 164, 165, 165 · ${t.gateTurnpikeExpress}`));
    await expect(rescue.locator('.rescue-list li', { hasText: w.widerTag })).toHaveCount(0);
  });
}
