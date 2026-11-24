import { test, expect } from '@playwright/test';
import { missingReturnDataset } from '../helpers/cityStops';
import { strings } from '../../src/ui/i18n';
import type { Favorite } from '../../src/domain/favorites';
import { parseDataset } from '../../src/domain/dataset';

const API = 'https://dale-live.test.workers.dev';
const favorite: Favorite = { id: 'fictional-recovery', label: 'Fictional commute', fromStopId: '2', toStopId: '3', routeIds: [],
  leave: { out: { walkMin: 7, cushionMin: 2 }, back: { walkMin: 3, cushionMin: 1 } } };
test.use({ serviceWorkers: 'block' });

for (const lang of ['en', 'es'] as const) test(`${lang}: missing-return briefing opens picker and saves only the return`, async ({ page }) => {
  const t = strings[lang], ds = missingReturnDataset();
  parseDataset(ds); // Fail on malformed fixtures before navigating to Home.
  await page.addInitScript(({ favorite, lang }) => {
    if (!localStorage.getItem('return-recovery-fixture')) {
      localStorage.setItem('return-recovery-fixture', '1');
      localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([favorite]));
      localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light', count: 3 }));
    }
  }, { favorite, lang });
  await page.route(API + '/**', async route => {
    if (new URL(route.request().url()).pathname === '/v1/schedule') await route.fulfill({ json: ds });
    else await route.abort();
  });
  await page.goto('/?live=1&now=2026-11-04T06:50');
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!));
  const home = page.locator('[data-favorite-id="fictional-recovery"]');
  await home.getByRole('button', { name: t.reverse, exact: true }).click();
  const briefing = page.locator('.briefing-commute');
  await briefing.getByRole('button', { name: t.commuteChanges.briefing.reselect, exact: true }).click();
  const picker = page.locator('.commute-picker');
  await expect(picker).toBeVisible();
  await expect(picker.locator('.stop-choice')).toContainText(['PORT AUTHORITY BUS TERMINAL']);
  await picker.getByRole('button', { name: t.cityPicker.cancel, exact: true }).click();
  expect(await stored()).toEqual([favorite]);
  await briefing.getByRole('button', { name: t.commuteChanges.briefing.reselect, exact: true }).click();
  await picker.locator('.stop-choice').click();
  await picker.getByRole('button', { name: /^Fort Lee/ }).click();
  await picker.locator('.stop-choice').click();
  await expect(picker.getByRole('heading', { name: t.cityPicker.review, exact: true })).toBeVisible();
  expect(await stored()).toEqual([favorite]);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  expect(await picker.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await picker.screenshot({ path: test.info().outputPath('return-review.png') });
  await picker.getByRole('button', { name: t.selection.save, exact: true }).click();
  const saved = { ...favorite, returnStops: { fromStopId: '3', toStopId: '1' } };
  await expect.poll(stored).toEqual([saved]);
  await expect(home.getByRole('button', { name: t.reverse, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(briefing.getByRole('button', { name: t.commuteChanges.briefing.timetable, exact: true })).toBeVisible();
  await page.reload();
  expect(await stored()).toEqual([saved]);
  await home.getByRole('button', { name: t.reverse, exact: true }).click();
  await expect(briefing.getByRole('button', { name: t.commuteChanges.briefing.timetable, exact: true })).toBeVisible();
  await expect(home.locator('[data-end="to"] .highway-name')).toHaveText('Fort Lee');
});
