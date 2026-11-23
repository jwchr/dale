import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { liveDataset, NOW } from '../helpers/liveBus';
import type { EarlierAnswer } from '../../src/domain/earlierBuses';

const API = 'https://dale-live.test.workers.dev';
test.use({ serviceWorkers: 'block' });
async function setup(page: Page, lang: 'en' | 'es', state: 'ready' | 'empty' | 'off' | 'mixed' = 'ready',
  options: { allRoutes?: boolean; outbound?: boolean; midnight?: boolean } = {}) {
  const initial = options.midnight ? Date.parse('2026-11-04T23:59:40-05:00') : NOW;
  await page.clock.install({ time: initial });
  await page.setViewportSize({ width: 320, height: 850 });
  await page.addInitScript(({ lang, options }) => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'household', theme: 'light' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'fixture', label: 'Test',
      fromStopId: options.outbound ? '3' : '1', toStopId: options.outbound ? '1' : '3', routeIds: options.allRoutes ? [] : ['10'] }]));
  }, { lang, options });
  const dataset = structuredClone(liveDataset);
  if (options.outbound) for (const p of dataset.patterns) {
    p.stopIds.reverse(); p.directionId = 1; p.headsign = 'Synthetic New Jersey';
  }
  await page.route(API + '/**', r => r.fulfill({ status: 503, body: 'Synthetic unavailable', headers: { 'access-control-allow-origin': '*' } }));
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: dataset, headers: { 'access-control-allow-origin': '*' } }));
  await page.route(API + '/v1/earlier-buses?**', async r => {
    if (state === 'off') return r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } });
    const q = new URL(r.request().url()).searchParams, generatedAt = options.midnight ? await page.evaluate(() => Date.now()) : NOW;
    const answer: EarlierAnswer = { v: 1, query: { route: q.get('route')!, stop: q.get('stop')!, direction: Number(q.get('direction')) as 0 | 1 },
      generatedAt, coverageStart: generatedAt - 3600_000, through: generatedAt - 30_000, gap: false,
      items: state === 'empty' ? [] : [{ route: q.get('route')!, direction: Number(q.get('direction')) as 0 | 1,
        stop: { scheduledAt: NOW - 20 * 60_000, evidence: { at: NOW - 17 * 60_000, sourceAt: NOW - 17 * 60_000, kind: 'gps', minutesLate: 3 } },
        portAuthority: { scheduledAt: NOW + 20 * 60_000, evidence: { at: NOW + 26 * 60_000, sourceAt: NOW - 10 * 60_000, kind: 'prediction', minutesLate: 6 } } }] };
    if (options.outbound) for (const bus of answer.items) bus.portAuthority = null;
    if (state === 'mixed') {
      const arrived = structuredClone(answer.items[0]!);
      arrived.stop.scheduledAt! -= 60_000;
      arrived.stop.evidence = null;
      arrived.portAuthority!.evidence = { kind: 'gps', at: NOW - 60_000, sourceAt: NOW - 60_000, minutesLate: -21 };
      answer.items.push(arrived);
    }
    return r.fulfill({ json: answer, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto(options.midnight ? '/?live=1' : '/?live=1&now=2026-11-04T07:20');
}

for (const lang of ['en', 'es'] as const) test(`all-routes commutes load both matching routes at 320px and 200% text (${lang})`, async ({ page }) => {
  const requested: string[] = [];
  page.on('request', r => { if (r.url().includes('/v1/earlier-buses?')) requested.push(new URL(r.url()).searchParams.get('route')!); });
  await setup(page, lang, 'ready', { allRoutes: true });
  const card = page.locator('.earlier-buses').first();
  await expect(card.locator('details')).toHaveCount(2);
  expect([...new Set(requested)].sort()).toEqual(['165', '165T']);
  await card.locator('summary').first().click();
  await expect(card).toContainText(lang === 'es' ? '3 min de retraso' : '3 min late');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

for (const lang of ['en', 'es'] as const) test(`outbound history omits the inapplicable terminal at 320px and 200% text (${lang})`, async ({ page }) => {
  await setup(page, lang, 'ready', { outbound: true });
  const card = page.locator('.earlier-buses').first();
  await expect(card.locator('summary')).toContainText(lang === 'es' ? '3 min de retraso' : '3 min late');
  await expect(card.locator('summary')).not.toContainText('Port Authority');
  await card.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(card.locator('dl dt')).toHaveCount(1);
  await expect(card.locator('dl')).not.toContainText('Port Authority');
  await expect(card.locator('dl')).toContainText(lang === 'es' ? 'Hora real exacta: Desconocido' : 'Exact actual time: Unknown');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await card.screenshot({ path: `/tmp/earlier-buses-outbound-${lang}.png` });
});

for (const lang of ['en', 'es'] as const) test(`refreshes immediately on the first clock update past Eastern midnight (${lang})`, async ({ page }) => {
  const requested: string[] = [];
  page.on('request', r => { if (r.url().includes('/v1/earlier-buses?')) requested.push(r.url()); });
  await setup(page, lang, 'empty', { midnight: true });
  const card = page.locator('.earlier-buses').first();
  await expect(card).toContainText(lang === 'es' ? 'No hay autobuses anteriores confirmados' : 'No earlier buses confirmed');
  expect(requested).toHaveLength(1);
  await page.clock.runFor(30_000);
  await expect.poll(() => requested.length).toBe(2);
  await expect(card).toContainText(lang === 'es' ? 'No hay autobuses anteriores confirmados' : 'No earlier buses confirmed');
  await expect(card).not.toContainText(lang === 'es' ? 'no está disponible' : 'unavailable right now');
});

for (const lang of ['en', 'es'] as const) test(`earlier buses on picker and exact-bus lock, 320px and large text (${lang})`, async ({ page }) => {
  await setup(page, lang);
  const es = lang === 'es', card = page.locator('.earlier-buses').first();
  await expect(card).toContainText(es ? 'Autobuses anteriores de hoy' : 'Earlier buses today');
  await expect(card).toContainText(es ? '3 min de retraso' : '3 min late');
  await expect(card).toContainText(es ? 'hace 17 min' : '17 min ago');
  await expect(card).toContainText(es ? 'Predicción de NJ Transit' : 'NJ Transit prediction');
  await expect(card).toContainText(/7:00/);
  await card.locator('summary').click();
  await expect(card.locator('details')).toHaveAttribute('open', '');
  await expect(card.locator('dl')).toContainText(/7:40/);
  await expect(card.locator('dl')).toContainText(/7:46/);
  const axe = await new AxeBuilder({ page }).include('.earlier-buses').analyze();
  expect(axe.violations).toEqual([]);
  for (const scale of [100, 200]) {
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
    const box = await card.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; });
  await page.locator('.dep').first().click();
  await page.getByRole('button', { name: es ? 'Seguir este autobús' : 'Lock onto this bus', exact: true }).click();
  // Official feed health may settle while reading history. Compare bus identity,
  // the exact-bus lock and rider actions, rather than volatile feed metadata.
  const lockedTrip = () => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('arriba.lock.v1.g2')!);
    const { officialFeed: _feed, ...session } = saved.session;
    return { ...saved, session };
  });
  const before = await lockedTrip();
  await page.locator('.earlier-buses summary').first().click();
  await expect(page.locator('.earlier-buses').first()).toContainText(es ? '3 min de retraso' : '3 min late');
  expect(await lockedTrip()).toEqual(before);
  await page.screenshot({ path: `/tmp/earlier-buses-${lang}.png`, fullPage: true });
});

for (const lang of ['en', 'es'] as const) for (const state of ['empty', 'off'] as const) test(`${state} state is clear (${lang})`, async ({ page }) => {
  await setup(page, lang, state);
  const card = page.locator('.earlier-buses').first();
  await expect(card).toContainText(state === 'empty'
    ? lang === 'es' ? 'No hay autobuses anteriores confirmados' : 'No earlier buses confirmed'
    : lang === 'es' ? 'no está disponible' : 'unavailable right now');
  await expect(card.locator('summary')).toHaveCount(0);
});

for (const lang of ['en', 'es'] as const) test(`each departed row opens its own times by keyboard; samples never become exact actuals (${lang})`, async ({ page }) => {
  await setup(page, lang, 'mixed');
  const es = lang === 'es', card = page.locator('.earlier-buses').first();
  const rows = card.locator('details');
  await expect(rows).toHaveCount(2);
  for (const i of [0, 1]) {
    await rows.nth(i).locator('summary').focus(); await page.keyboard.press('Enter');
    await expect(rows.nth(i)).toHaveAttribute('open', '');
    await expect(rows.nth(i).locator('dl')).toContainText(es ? 'Hora real exacta: Desconocido' : 'Exact actual time: Unknown');
    await expect(rows.nth(i).locator('dl')).toContainText(es ? 'Horario de NJ Transit' : 'NJ Transit schedule');
  }
  await expect(rows.nth(0).locator('dl')).toContainText(es ? 'Previsto: 7:46' : 'Expected: 7:46');
  await expect(rows.nth(1).locator('dl')).toContainText(es ? 'Muestra observada en parada: 7:19' : 'Observed stop sample: 7:19');
  await expect(rows.nth(1).locator('dl')).not.toContainText(es ? 'Previsto:' : 'Expected:');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; } body { font-family: Verdana, sans-serif !important; }' });
  for (const skin of ['household', 'turnpike', 'parkway', 'nyc', 'garden', 'clean']) {
    await page.evaluate(skin => { document.documentElement.dataset.skin = skin; }, skin);
    for (const width of [305, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
  }
  expect(await page.evaluate(() => localStorage.getItem('arriba.lock.v1.g2'))).toBeNull();
});
