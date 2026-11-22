import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import type { CommuteChanges as CommuteChangesComponent } from '../../src/ui/CommuteChanges';
import { strings } from '../../src/ui/i18n';
import type { CommuteChange } from '../../src/domain/commuteChanges';
import { liveDataset } from '../helpers/liveBus';

// Exercise the component boundary directly: the normal notice store prunes deleted favorites.
// A stale caller can still render a notice without its favorite; do not offer a dead recovery action.
const css = readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');
const favorite = { id: 'fictional-favorite', label: 'Fictional commute', fromStopId: '1', toStopId: '3', routeIds: [] };
let vite: ViteDevServer;
let CommuteChanges: typeof CommuteChangesComponent;
test.beforeAll(async () => {
  // Playwright's JSX transform creates locator objects, not React elements. Load the
  // real component through Vite's SSR transform for these static layout fixtures.
  vite = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, ws: false } });
  ({ CommuteChanges } = await vite.ssrLoadModule('/src/ui/CommuteChanges.tsx'));
});
test.afterAll(async () => { await vite?.close(); });

for (const lang of ['en', 'es'] as const) for (const kind of ['selection', 'uncomparable'] as const) {
  test(`${lang}/${kind}: deleted favorite has no dead recovery action at 320px/200%`, async ({ page }) => {
    const notice: CommuteChange = { id: 'fictional-notice', favoriteId: favorite.id, favoriteKey: 'fictional-key',
      fromVersion: 'fictional-before', toVersion: 'fictional-after', kind, before: [], after: [] };
    const render = (present: boolean) => renderToStaticMarkup(createElement(CommuteChanges, {
      ds: liveDataset, now: Date.parse('2026-11-23T08:00:00-05:00'), t: strings[lang], lang, tz: 'America/New_York',
      notices: [notice], favorites: present ? [favorite] : [], durable: true, reversedIds: new Set<string>(),
      dismiss: async () => {}, onTimetable: () => {}, onReselect: () => {},
    }));
    await page.setViewportSize({ width: 320, height: 900 });
    const content = (present: boolean) => `<!doctype html><html lang="${lang}" data-theme="light"><head><title>Fictional notice test</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${css}\nhtml { font-size: 200% !important; }</style></head><body><main>${render(present)}</main></body></html>`;
    await page.setContent(content(true));
    const card = page.locator('.commute-change');
    const reselect = card.getByRole('button', { name: strings[lang].commuteChanges.briefing.reselect });
    await expect(reselect).toBeVisible();
    await page.setContent(content(false));
    await expect(card).toHaveCount(1);
    await expect(reselect).toHaveCount(0);
    await expect(card.getByRole('button')).toHaveCount(1); // Dismiss remains available.
    await card.locator('summary').focus(); await page.keyboard.press('Enter');
    await expect(card.locator('details')).toHaveAttribute('open', '');
    expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true);
    const audit = await new AxeBuilder({ page }).include('.commute-changes').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('deleted-favorite.png'), fullPage: true });
  });
}
