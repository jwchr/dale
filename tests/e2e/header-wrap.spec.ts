import { expect, test } from '@playwright/test';

// The top bar at enlarged text, in every skin and both languages, on the home and train screens.
// DejaVu Sans is the wide fallback font on the Linux CI runner; Turnpike has the widest (boxed) wordmark.
const favorites = [{ id: 'reference', label: 'Hackensack → New York', fromStopId: 'N10', toStopId: 'PABT', routeIds: [] }];
test.use({ serviceWorkers: 'block' });
for (const skin of ['turnpike', 'parkway', 'nyc', 'garden', 'clean']) for (const lang of ['en', 'es'] as const) for (const screen of ['home', 'train'] as const) {
  test(`top bar keeps settings with the wordmark or Back at enlarged text (${skin}, ${lang}, ${screen})`, async ({ page }) => {
    await page.addInitScript(({ skin, lang, favorites }) => {
      localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, theme: 'light', skin }));
      localStorage.setItem('arriba.favorites.v1', JSON.stringify(favorites));
    }, { skin, lang, favorites });
    for (const width of [305, 320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/?printed=1&now=2026-11-04T07:50');
      await expect(page.locator('.dep').first()).toBeVisible();
      if (screen === 'train') await page.getByRole('button', { name: lang === 'es' ? 'Tren' : 'Train', exact: true }).click();
      await expect(page.locator('header.top .top-version')).toBeVisible();
      for (const font of ['', 'DejaVu Sans']) for (let scale = 100; scale <= 200; scale += 10) {
        const header = await page.locator('header.top').evaluate((node, { scale, font }) => {
          document.documentElement.style.fontSize = `${scale}%`; document.body.style.fontFamily = font;
          const box = (e: Element) => e.getBoundingClientRect();
          const wordmark = box(node.querySelector('.wordmark')!), stamp = node.querySelector('.top-version')!;
          const buttons = [...node.querySelectorAll('.icon-btn')].map(box), settings = buttons.at(-1)!;
          const lines = [...stamp.querySelectorAll('.nowrap')].flatMap(part => { const r = document.createRange(); r.selectNodeContents(part); return [...r.getClientRects()].filter(x => x.width > 0); });
          const splitWords: string[] = [];
          // Every text node (React renders "· " and the time separately); each word must render on one line.
          const walker = document.createTreeWalker(stamp, NodeFilter.SHOW_TEXT);
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            if (text.parentElement!.closest('.sr-only')) continue;
            for (const m of text.textContent!.matchAll(/\S+/g)) {
              const r = document.createRange(); r.setStart(text, m.index!); r.setEnd(text, m.index! + m[0].length);
              if ([...r.getClientRects()].filter(x => x.width > 0).length !== 1) splitWords.push(m[0]);
            }
          }
          const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
          const sameRow = (a: DOMRect, b: DOMRect) => a.top < b.bottom && b.top < a.bottom;
          return {
            settingsBesideWordmark: sameRow(settings, wordmark),
            // Settings may move down only together with Back or beside the stamp, never onto a row of its own.
            settingsAlone: !sameRow(settings, wordmark) && !buttons.slice(0, -1).some(b => sameRow(b, settings)) && !lines.some(l => sameRow(l, settings)),
            overlaps: [...buttons.map(b => overlaps(b, wordmark)), ...lines.map(l => overlaps(l, wordmark) || buttons.some(b => overlaps(l, b))),
              ...buttons.map((b, i) => buttons.some((c, j) => j !== i && overlaps(b, c)))].filter(Boolean).length,
            splitWords, overflow: document.documentElement.scrollWidth - innerWidth, height: box(node).height,
          };
        }, { scale, font });
        const detail = JSON.stringify({ width, font, scale, header });
        expect([header.settingsAlone, header.overlaps, header.splitWords, header.overflow], detail).toEqual([false, 0, [], 0]);
        // The home bar has room for settings beside the wordmark at every tested size.
        if (screen === 'home') expect(header.settingsBesideWordmark, detail).toBe(true);
        expect(header.height, detail).toBeLessThanOrEqual(800 * 0.3);
      }
    }
  });
}
