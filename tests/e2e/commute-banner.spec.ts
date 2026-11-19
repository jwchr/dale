import { expect, test } from '@playwright/test';
import { liveDataset, NOW } from '../helpers/liveBus';

const API = 'https://dale-live.test.workers.dev';

// HANDOFF's large-text name-banner bug: an oversized word may wrap, but never strand
// one letter on its own. Use actual glyph positions, not a CSS/string assertion.
for (const skin of ['household', 'turnpike', 'parkway', 'nyc', 'garden', 'clean']) {
  for (const lang of ['en', 'es']) test(`custom commute banner at large text (${skin}, ${lang})`, async ({ page }) => {
    const favorites = [{ id: 'banner', fromStopId: '2', toStopId: '3', routeIds: [], label: 'Hackensack' }];
    await page.addInitScript(({ skin, lang, favorites }) => {
      localStorage.setItem('arriba.settings.v1', JSON.stringify({ skin, lang, theme: 'light' }));
      localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify(favorites));
    }, { skin, lang, favorites });
    await page.clock.install({ time: NOW });
    await page.route(API + '/v1/schedule', route => route.fulfill({ json: liveDataset }));
    await page.route(API + '/v1/departures?**', route => route.abort('failed'));
    await page.route(API + '/v1/geometry?**', route => route.abort('failed'));
    await page.goto('/?live=1');
    const banner = page.locator('.commute-led');
    await expect(banner).toHaveText('Hackensack');
    for (const width of [305, 320, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const size of ['100%', '200%']) {
        await page.evaluate(size => { document.documentElement.style.fontSize = size; }, size);
        for (const font of ['monospace', 'Arial, sans-serif']) {
          await banner.evaluate((node, font) => { node.style.fontFamily = font; }, font);
          const layout = await banner.evaluate(node => {
            const box = node.getBoundingClientRect(), lines = new Map<number, string>();
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            let text: Node | null;
            let inside = true;
            while ((text = walker.nextNode())) {
              for (let i = 0; i < (text.textContent?.length ?? 0); i++) {
                const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1);
                const r = range.getBoundingClientRect(), y = Math.round(r.top);
                lines.set(y, (lines.get(y) ?? '') + text.textContent![i]);
                inside &&= r.left >= box.left - 1 && r.right <= box.right + 1;
              }
            }
            return { lines: [...lines.values()].map(line => line.trim()).filter(Boolean), inside,
              overflow: document.documentElement.scrollWidth > innerWidth + 1 };
          });
          const detail = JSON.stringify({ skin, lang, width, size, font, ...layout });
          expect(layout.lines.every(line => line.length > 1), detail).toBe(true);
          expect(layout.inside, detail).toBe(true);
          expect(layout.overflow, detail).toBe(false);
          await expect(banner).toHaveAccessibleName('Hackensack');
        }
      }
    }
  });
}
