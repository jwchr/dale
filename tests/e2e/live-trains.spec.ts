import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { strings } from '../../src/ui/i18n';

// Synthetic Worker answers only (no recorded NJ Transit data). Pinned page time: Nov 4, 2026, 7:50 AM New York (12:50 UTC).
const API = 'https://dale-live.test.workers.dev';
const NOW = Date.parse('2026-11-04T12:50:00Z');
const dep = (trainId: string, minutes: number, over: Record<string, unknown> = {}) => ({ trainId, line: 'Pascack Valley Line', lineCode: 'PV', destination: 'Hoboken',
  scheduledAt: NOW + minutes * 60_000, track: null, status: null, secondsLate: null, updatedAt: null, ...over });
const board = (station: string, departures: unknown[], receivedAt = NOW - 30_000) => ({ v: 1, source: 'NJ Transit RailData', station, state: 'ok', receivedAt, departures, skippedRows: 0 });

test.use({ serviceWorkers: 'block', viewport: { width: 320, height: 780 } });

async function open(page: Page, lang: 'en' | 'es', answers: Record<string, unknown>) {
  const asked: string[] = [];
  await page.addInitScript((lang) => localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, theme: 'dark', skin: 'garden' })), lang);
  await page.route(API + '/v1/rail?**', (route) => {
    const station = new URL(route.request().url()).searchParams.get('station')!;
    asked.push(station);
    const answer = answers[station];
    return answer ? route.fulfill({ json: answer }) : route.fulfill({ status: 503, body: '' });
  });
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await page.getByRole('button', { name: strings[lang].journey.trainMode, exact: true }).click();
  return asked;
}
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const lang of ['en', 'es'] as const) {
  test(`live train board leads, shows only NJ Transit's fields and keeps the sample folded (${lang})`, async ({ page }) => {
    const t = strings[lang], l = t.rail.live;
    const asked = await open(page, lang, { AS: board('AS', [dep('1604', 8, { track: '1', status: 'BOARDING', secondsLate: 0 }), dep('1606', 40, { secondsLate: 180, destination: 'Hoboken Terminal' })]) });
    const live = page.locator('.rail-live');
    await expect(live).toHaveCount(1);
    await expect(page.locator('.badge-live')).toHaveText(l.badge);
    await expect(live.locator('.rail-board-title')).toHaveText(l.board('Anderson Street'));
    await expect(live.locator('.rail-live-age')).toHaveText(l.age(0));
    const rows = live.locator('.rail-live-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('.rail-live-time')).toHaveText(lang === 'es' ? '7:58 a.m.' : '7:58 AM');
    await expect(rows.nth(0)).toContainText(l.trackNo('1'));
    await expect(rows.nth(0)).toContainText('BOARDING');
    await expect(rows.nth(0).locator('.rail-live-late')).toHaveCount(0);
    await expect(rows.nth(1)).toContainText(l.noTrack);
    await expect(rows.nth(1).locator('.rail-live-late')).toHaveText(l.late(3));
    await expect(page.locator('.rail-sample')).not.toHaveAttribute('open');
    await expect(page.getByText(t.rail.notice, { exact: true })).toHaveCount(0);
    expect(new Set(asked)).toEqual(new Set(['AS']));
    expect(await noOverflow(page)).toBe(true);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    expect(await noOverflow(page)).toBe(true);
    const axe = await new AxeBuilder({ page }).include('.rail-preview').analyze();
    expect(axe.violations).toEqual([]);
    // The sample stays one tap away and opens by keyboard.
    await page.locator('.rail-sample > summary').focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.rail-sample')).toHaveAttribute('open', '');
    await expect(page.locator('.rail-sample .rail-option')).toHaveCount(3);
  });

  test(`coming home shows Penn and the Secaucus Pascack Valley level, and says which one is missing (${lang})`, async ({ page }) => {
    const l = strings[lang].rail.live;
    const asked = await open(page, lang, { TS: board('TS', [dep('1609', 30, { destination: 'Spring Valley' })]) });
    await page.getByRole('button', { name: strings[lang].journey.returning, exact: true }).click();
    await expect(page.locator('.rail-live')).toHaveCount(1);
    await expect(page.locator('.rail-live .rail-board-title')).toHaveText(l.board(l.stations.TS));
    await expect(page.getByText(l.unavailableOne(l.stations.NY), { exact: true })).toBeVisible();
    expect(asked).toEqual(expect.arrayContaining(['NY', 'TS']));
  });

  test(`an old answer is flagged as out of date (${lang})`, async ({ page }) => {
    const t = strings[lang], l = t.rail.live;
    await open(page, lang, { AS: board('AS', [dep('1604', 8)], NOW - 5 * 60_000) });
    await expect(page.locator('.rail-live-age.stale')).toHaveText(l.stale(5));
    await expect(page.locator('.rail-live-age.stale')).toHaveAttribute('role', 'alert');
  });

  test(`live trains unavailable: sample timetable stays, labeled (${lang})`, async ({ page }) => {
    const t = strings[lang];
    await open(page, lang, {});
    await expect(page.getByText(t.rail.live.unavailable, { exact: true })).toBeVisible();
    await expect(page.getByText(t.rail.notice, { exact: true })).toBeVisible();
    await expect(page.locator('.badge-sched')).toHaveText(t.rail.sample);
    await expect(page.locator('.rail-live')).toHaveCount(0);
    await expect(page.locator('.rail-option')).toHaveCount(3);
  });
}
