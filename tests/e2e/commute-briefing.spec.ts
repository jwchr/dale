import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { liveDataset } from '../helpers/liveBus';
import { advanceCommuteChanges } from '../../src/domain/commuteChanges';
import type { Dataset } from '../../src/domain/types';
import { parseDataset } from '../../src/domain/dataset';
import type { Favorite } from '../../src/domain/favorites';

const API = 'https://dale-live.test.workers.dev';
const PIN = '2026-11-21T08:00:00-05:00';
const favorite = { id: 'briefing-fixture', label: 'Fictional commute', fromStopId: '1', toStopId: '3', routeIds: [] };
function fixture() {
  const ds = structuredClone(liveDataset);
  ds.meta.builtAt = '2026-11-20T12:00:00Z'; ds.meta.source = 'NJ Transit · fictional test schedule';
  ds.stops.push({ id: 'return-home', name: 'Fictional return stop', twin: '1' });
  ds.patterns.push({ id: 'back', routeId: ds.routes[0]!.id, directionId: 1, headsign: 'Fictional home', stopIds: ['3','return-home'] });
  ds.trips.push({ id: 'back', patternId: 'back', serviceId: 'WK', times: [61200,63600], arrivals: [61200,63600] });
  return ds;
}
function replacement() {
  const ds = fixture(); ds.meta.feedVersion = 'fictional-v2'; ds.meta.builtAt = '2026-11-21T12:00:00Z';
  const trip = ds.trips.find(t => t.id === 'T1')!;
  trip.times = trip.times.map(s => s + 180); trip.arrivals = trip.arrivals?.map(s => s === null ? null : s + 180);
  return ds;
}
async function setup(page: Page, dataset: Dataset, lang = 'en', pin = PIN, notices = false, printed = false, savedFavorite: Favorite = favorite) {
  parseDataset(dataset); // Fail on invalid fixtures before waiting for a card that cannot load.
  await page.clock.setFixedTime(new Date(pin));
  const unexpected: string[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === API) {
      if (url.pathname === '/v1/schedule') return route.fulfill({ json: dataset, headers: { 'access-control-allow-origin': '*' } });
      if (!['/v1/departures','/v1/geometry','/v1/arrival-confidence'].includes(url.pathname)) unexpected.push(url.pathname);
      return route.abort();
    }
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
    unexpected.push(url.origin); return route.abort();
  });
  await page.goto('/licenses.txt');
  await page.evaluate(async ({ dataset, favorite, API, notices, lang, pin, printed }) => {
    localStorage.setItem('arriba.favorites.v1' + (printed ? '' : '.g2'), JSON.stringify([favorite]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light', count: 3 }));
    if (printed) return;
    if (notices) await (await caches.open('dale-commute-changes-v1')).put(API + '/v1/local-commute-changes', new Response(JSON.stringify(notices)));
    await (await caches.open('dale-live-schedule-v1')).put(API + '/v1/schedule', new Response(JSON.stringify(dataset), { headers: { 'x-arriba-saved-at': String(Date.parse(pin) - 3600000) } }));
  }, { dataset, favorite: savedFavorite, API, notices: notices ? advanceCommuteChanges(advanceCommuteChanges(undefined, fixture(), [savedFavorite], Date.parse(pin)), dataset, [savedFavorite], Date.parse(pin)) : undefined, lang, pin, printed });
  if (printed) await page.route('**/data/corridor.json', route => route.fulfill({ json: dataset }));
  await page.goto(`/?${printed ? 'printed=1' : 'live=1'}&now=${encodeURIComponent(pin)}`);
  await expect(page.locator('.briefing-commute')).toHaveCount(1);
  return unexpected;
}
const region = (page: Page) => page.locator('.commute-changes');

for (const lang of ['en','es']) {
  for (const scope of ['missing', 'mixed'] as const) {
    test(`${lang}: ${scope} saved routes remain explicit at 320px/200%`, async ({ page }) => {
      const ds = fixture(), route = ds.routes[0]!;
      const saved = { ...favorite, routeIds: scope === 'missing' ? ['missing-one', 'missing-two'] : [route.id, 'missing-one'] };
      await setup(page, ds, lang, PIN, false, false, saved);
      await page.setViewportSize({ width: 320, height: 900 });
      await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
      const card = region(page).locator('.briefing-commute'), label = card.locator('.briefing-scope');
      const missing = lang === 'en' ? 'Selected route unavailable' : 'Ruta seleccionada no disponible';
      await expect(label).toContainText(scope === 'missing' ? `${missing} / ${missing}` : `${route.shortName} / ${missing}`);
      await expect(label).not.toContainText(lang === 'en' ? 'All matching routes' : 'Todas las rutas que coinciden');
      await expect(card).toContainText(lang === 'en' ? 'Service is unknown' : 'Servicio desconocido');
      const reselect = card.getByRole('button', { name: lang === 'en' ? 'Check saved stops and routes' : 'Revisar paradas y rutas guardadas' });
      await expect(reselect).toBeVisible();
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true);
      await page.screenshot({ path: test.info().outputPath('missing-routes.png'), fullPage: true });
      await reselect.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('.commute-picker')).toBeVisible();
    });
  }
  for (const problem of ['selection', 'coverage'] as const) {
    test(`${lang}: printed holiday with unknown ${problem} preserves recovery at 320px/200%`, async ({ page }) => {
      const ds = fixture(); ds.meta.transcribed = { issued: '20260701', documentId: 'fictional-test' }; delete ds.meta.realtime;
      if (problem === 'coverage') ds.calendars.WK!.end = '20261120';
      const saved = problem === 'selection' ? { ...favorite, fromStopId: 'absent' } : favorite;
      await setup(page, ds, lang, '2026-11-26T08:00:00-05:00', false, true, saved);
      await page.setViewportSize({ width: 320, height: 900 });
      await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
      const card = region(page).locator('.briefing-commute');
      await expect(card).toContainText(lang === 'en' ? 'Service is unknown' : 'Servicio desconocido');
      await expect(card).not.toContainText(lang === 'en' ? 'This date is on the printed holiday list' : 'Esta fecha está en la lista impresa');
      const reselect = card.getByRole('button', { name: lang === 'en' ? 'Check saved stops and routes' : 'Revisar paradas y rutas guardadas' });
      await expect(reselect).toBeVisible();
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true);
      await reselect.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('.commute-picker')).toBeVisible();
    });
  }
  test(`${lang}: replacement, provenance, actions, keyboard dismissal and reverse at 320px/200%`, async ({ page }) => {
    const unexpected = await setup(page, replacement(), lang, PIN, true);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    const briefing = region(page), notice = briefing.locator('.commute-change');
    await expect(briefing).toContainText(lang === 'en' ? "Couldn't check current alerts" : 'No se pudieron consultar las alertas actuales');
    await expect(notice).toContainText('fictional-v2');
    await expect(notice).toContainText(lang === 'en' ? 'Build age: 1 hr' : 'Antigüedad del archivo: hace 1 h');
    await notice.locator('summary').focus(); await page.keyboard.press('Enter');
    await expect(notice).toContainText('7:03'); await expect(notice).toContainText('fixture-live → fictional-v2');
    await briefing.locator('.briefing-commute summary').focus(); await page.keyboard.press('Enter');
    await expect(briefing).toContainText(lang === 'en' ? 'Last successful schedule check:' : 'Última consulta exitosa del horario:');
    await expect(briefing).toContainText(lang === 'en' ? 'publication/update time unknown' : 'publicación/actualización de la fuente desconocida');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('.commute-changes').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(audit.violations).toEqual([]);
    const saved = await page.evaluate(() => localStorage.getItem('arriba.favorites.v1.g2'));
    await notice.getByRole('button', { name: /Dismiss schedule update|Descartar actualización/ }).focus();
    await page.keyboard.press('Enter'); await expect(notice).toHaveCount(0);
    await page.reload(); await expect(notice).toHaveCount(0);
    await page.getByRole('button', { name: lang === 'en' ? 'Reverse' : 'Invertir', exact: true }).first().click();
    await expect(briefing.locator('.briefing-commute h3')).toContainText(lang === 'en' ? 'Return' : 'Regreso');
    await expect(briefing).toContainText('Fictional return stop');
    const action = briefing.getByRole('button', { name: lang === 'en' ? 'Open full timetable' : 'Abrir horario completo', exact: true });
    await action.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.timetable')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('arriba.favorites.v1.g2'))).toBe(saved);
    expect(await page.evaluate(() => localStorage.getItem('arriba.lock.v1.g2'))).toBeNull();
    expect(unexpected).toEqual([]);
  });
  test(`${lang}: covered holiday calendar, chosen date and expired coverage stay distinct`, async ({ page }) => {
    const ds = fixture(); await setup(page, ds, lang, '2026-11-26T08:00:00-05:00');
    await expect(region(page)).toContainText(lang === 'en' ? '2 matching scheduled departures' : '2 salidas programadas');
    await region(page).getByRole('combobox').selectOption('20261127');
    await region(page).getByRole('button', { name: lang === 'en' ? 'Open full timetable' : 'Abrir horario completo' }).click();
    await expect(page.getByRole('tab', { selected: true })).toContainText(lang === 'en' ? 'Tomorrow' : 'Mañana');
  });
  test(`${lang}: covered no-service is a calendar fact, never a live cancellation`, async ({ page }) => {
    const ds = fixture(); ds.calendars.WK!.removed.push('20261125'); ds.calendars.HOL!.added = [];
    await setup(page, ds, lang, '2026-11-26T08:00:00-05:00');
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(region(page)).toContainText(lang === 'en' ? 'covered calendar has no matching scheduled departures' : 'calendario cubierto no tiene salidas programadas');
    await expect(region(page)).toContainText(lang === 'en' ? 'not a cancellation notice' : 'No es un aviso de cancelación');
    await expect(region(page)).toContainText(lang === 'en' ? "Couldn't check current alerts" : 'No se pudieron consultar las alertas actuales');
  });
  test(`${lang}: printed holiday warns without creating holiday times`, async ({ page }) => {
    const ds = fixture(); ds.meta.transcribed = { issued: '20260701', documentId: 'fictional-test' };
    delete ds.meta.realtime; // Printed schedules cannot also claim a live-feed provider.
    await setup(page, ds, lang, '2026-11-26T08:00:00-05:00', false, true);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await expect(region(page)).toContainText(lang === 'en' ? 'Holiday departure times are unavailable' : 'horas de salida del feriado no están disponibles');
    await region(page).locator('.briefing-commute summary').click();
    await expect(region(page)).toContainText(lang === 'en' ? 'Printed issue date: July 1, 2026' : 'Fecha de edición impresa: 1 de julio de 2026');
    expect(await region(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true);
  });
  test(`${lang}: offline copy is last known, source age increases, failed checks keep changes`, async ({ page }) => {
    const ds = replacement(); await setup(page, ds, lang, PIN, true);
    await page.route(API + '/v1/schedule', route => route.abort());
    await page.reload(); await expect(region(page).locator('.commute-change')).toHaveCount(1);
    await region(page).locator('.briefing-commute summary').click();
    await expect(region(page)).toContainText(lang === 'en' ? 'Offline saved schedule' : 'Horario guardado sin conexión');
    await expect(region(page)).toContainText(lang === 'en' ? 'No successful alert check' : 'Ninguna consulta de alertas exitosa');
    await expect(region(page)).toContainText(lang === 'en' ? 'Offline copy saved:' : 'Copia sin conexión guardada:');
    await expect(region(page)).toContainText(lang === 'en' ? 'Last successful schedule check unknown' : 'Última consulta exitosa del horario desconocida');
    await page.goto(`/?live=1&now=${encodeURIComponent('2026-11-21T10:00:00-05:00')}`);
    await expect(region(page).locator('.commute-change')).toContainText(lang === 'en' ? '3 hr ago' : 'hace 3 h');
  });
}

test('uncovered date cannot claim no service; blocked storage keeps notices session-only', async ({ page }) => {
  const ds = replacement();
  await setup(page, ds, 'en', '2027-05-03T08:00:00-04:00');
  await expect(region(page)).toContainText('Service is unknown');
  await expect(region(page).getByRole('button', { name: 'Check saved stops and routes' })).toBeVisible();
  await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }));
  await page.reload();
  await expect(region(page)).toContainText('cannot safely save');
});

for (const pin of ['2026-11-22T00:30:00-05:00','2026-11-01T01:30:00-04:00','2026-11-01T01:30:00-05:00','2027-03-14T03:30:00-04:00']) {
  test(`Eastern pinned instant ${pin} keeps dated timetable and 12-hour clocks`, async ({ page }) => {
    const ds = fixture(); ds.calendars.WK!.days = [true,true,true,true,true,true,true]; ds.calendars.WK!.start = '20261031';
    const unexpected = await setup(page, ds, 'en', pin);
    await page.setViewportSize({ width: 320, height: 900 });
    await region(page).getByRole('button', { name: 'Open full timetable' }).click();
    await expect(page.locator('.timetable')).toContainText(/AM|PM/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true);
    expect(unexpected).toEqual([]);
  });
}
