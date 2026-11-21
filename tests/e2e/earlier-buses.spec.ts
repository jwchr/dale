import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { liveDataset, NOW } from '../helpers/liveBus';
import type { EarlierAnswer } from '../../src/domain/earlierBuses';

const API = 'https://dale-live.test.workers.dev';
test.use({ serviceWorkers: 'block' });
async function setup(page: Page, lang: 'en' | 'es', state: 'ready' | 'empty' | 'off' | 'mixed' = 'ready') {
  await page.clock.install({ time: NOW });
  await page.setViewportSize({ width: 320, height: 850 });
  await page.addInitScript(lang => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'household', theme: 'light' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'fixture', label: 'Test', fromStopId: '1', toStopId: '3', routeIds: ['10'] }]));
  }, lang);
  await page.route(API + '/**', r => r.fulfill({ status: 503, body: 'Synthetic unavailable', headers: { 'access-control-allow-origin': '*' } }));
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: liveDataset, headers: { 'access-control-allow-origin': '*' } }));
  await page.route(API + '/v1/earlier-buses?**', r => {
    if (state === 'off') return r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } });
    const q = new URL(r.request().url()).searchParams;
    const answer: EarlierAnswer = { v: 1, query: { route: q.get('route')!, stop: q.get('stop')!, direction: Number(q.get('direction')) as 0 | 1 },
      generatedAt: NOW, coverageStart: NOW - 3600_000, through: NOW - 30_000, gap: false,
      items: state === 'empty' ? [] : [{ route: q.get('route')!, direction: 0,
        stop: { scheduledAt: NOW - 20 * 60_000, evidence: { at: NOW - 17 * 60_000, sourceAt: NOW - 17 * 60_000, kind: 'gps', minutesLate: 3 } },
        portAuthority: { scheduledAt: NOW + 20 * 60_000, evidence: { at: NOW + 26 * 60_000, sourceAt: NOW - 10 * 60_000, kind: 'prediction', minutesLate: 6 } } }] };
    if (state === 'mixed') {
      const arrived = structuredClone(answer.items[0]!);
      arrived.stop.scheduledAt! -= 60_000;
      arrived.stop.evidence = null;
      arrived.portAuthority!.evidence = { kind: 'gps', at: NOW - 60_000, sourceAt: NOW - 60_000, minutesLate: -21 };
      answer.items.push(arrived);
    }
    return r.fulfill({ json: answer, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto('/?live=1&now=2026-11-04T07:20');
}

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
