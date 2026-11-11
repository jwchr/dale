import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import reference from '../fixtures/garden-approved-reference.json' with { type: 'json' };
import { strings } from '../../src/ui/i18n';

const favorites = [{ id: 'reference', label: 'Hackensack - State St. at Lawerence St. (to New York) → New York - Port Authority Bus Terminal', fromStopId: 'N10', toStopId: 'PABT', routeIds: [] }];
test.use({ serviceWorkers: 'block' });
for (const lang of ['en', 'es'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`Garden State matches approved green/gold appearance and retains current controls (${lang}, ${theme})`, async ({ page }) => {
    const t = strings[lang];
    await page.addInitScript(({ lang, theme, favorites }) => {
      Math.random = () => 0; // Same approved Paterson photo as the immutable reference.
      localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, theme, skin: 'garden' }));
      localStorage.setItem('arriba.favorites.v1', JSON.stringify(favorites));
      localStorage.setItem('arriba.penn-guide.v1.bus', JSON.stringify({ mode: 'bus', station: 'essex', direction: 'return', travelling: true, step: 3 }));
    }, { lang, theme, favorites });
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto('/?printed=1&now=2026-11-04T07:50');
    await expect(page.locator('.dep').first()).toBeVisible();
    await expect(page.locator('.photo-backdrop')).toHaveAttribute('data-photo', 'paterson-great-falls');
    const initialPreferences = await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.settings.v1')!));
    const visual = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const surfaces = Object.fromEntries(Object.entries({ card: '.fav', city: '[data-end="from"] .highway-sign', stop: '[data-end="from"] .commute-stop', departure: '.dep-next' }).map(([name, selector]) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return [name, { background: style.background, color: style.color, border: style.border }];
      }));
      return { tokens: Object.fromEntries(['--bg','--surface','--text','--brand','--accent'].map(key => [key, css.getPropertyValue(key).trim()])), surfaces,
        photoFilter: getComputedStyle(document.querySelector('.photo-backdrop')!).filter,
        wordmark: getComputedStyle(document.querySelector('.wordmark')!).color,
        bang: getComputedStyle(document.querySelector('.wordmark .bang')!).color,
        local: getComputedStyle(document.querySelector('.route-badge:not([data-express="true"])')!).backgroundColor,
        express: getComputedStyle(document.querySelector('.route-badge[data-express="true"]')!).backgroundColor,
        scheme: css.colorScheme };
    });
    expect(visual.tokens).toEqual(reference.tokens);
    expect(visual.surfaces).toEqual(reference.surfaces);
    expect(visual.photoFilter).toBe('blur(3px) brightness(0.62)');
    expect(visual.wordmark).toBe('rgb(255, 251, 234)');
    expect(visual.bang).toBe('rgb(243, 198, 66)');
    expect(visual.local).toBe('rgb(13, 92, 58)');
    expect(visual.express).toBe('rgb(243, 198, 66)');
    expect(visual.scheme).toBe('dark');
    for (const [width, scale] of [[390,100],[305,100],[320,130],[320,200]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
      const geometry = await page.locator('.commute-places').evaluate(signs => {
        const from = signs.querySelector('[data-end="from"]')!.getBoundingClientRect();
        const to = signs.querySelector('[data-end="to"]')!.getBoundingClientRect();
        return { sameRow: Math.abs(from.top - to.top) < 1, separate: from.right < to.left, stacked: to.top > from.bottom, overflow: document.documentElement.scrollWidth - innerWidth };
      });
      // Paired where names fit whole (390px at normal text), stacked on narrower phones and enlarged text (owner request 2026-11-11).
      const paired = scale === 100 && width >= 390;
      expect(geometry).toEqual({ sameRow: paired, separate: paired, stacked: !paired, overflow: 0 });
      // The version stamp may share the wordmark row or, when enlarged text leaves no room, take its own row.
      // Either way it must not touch the wordmark or settings, must never split a word, and the header stays compact.
      const headerFor = (font: string) => page.locator('header.top').evaluate((header, font) => {
        document.body.style.fontFamily = font;
        const box = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
        const wordmark = box(header.querySelector('.wordmark')!.getBoundingClientRect());
        const settings = box(header.querySelector('.icon-btn')!.getBoundingClientRect());
        const lines = [...header.querySelectorAll('.top-version .nowrap')].flatMap(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          return [...range.getClientRects()].filter(rect => rect.width > 0).map(box);
        });
        const splitWords: string[] = [];
        // Every text node: React renders "· " and the time as separate nodes.
        for (const node of header.querySelectorAll('.top-version .nowrap')) {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          for (let text = walker.nextNode(); text; text = walker.nextNode()) for (const match of text.textContent!.matchAll(/\S+/g)) {
            const range = document.createRange(); range.setStart(text, match.index!); range.setEnd(text, match.index! + match[0].length);
            if ([...range.getClientRects()].filter(rect => rect.width > 0).length !== 1) splitWords.push(match[0]);
          }
        }
        const overlaps = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const result = { font, wordmark, settings, lines, splitWords, height: header.getBoundingClientRect().height,
          touches: lines.filter(line => overlaps(line, wordmark) || overlaps(line, settings)).length,
          outside: lines.filter(line => line.left < 0 || line.right > innerWidth).length,
          sameRow: (block => block.top < wordmark.bottom && block.bottom > wordmark.top)(header.querySelector('.top-version')!.getBoundingClientRect()),
          settingsBesideWordmark: settings.top < wordmark.bottom };
        document.body.style.fontFamily = '';
        return result;
      }, font);
      // DejaVu Sans is the wide fallback that made the stamp break letter by letter on the Linux CI runner.
      for (const font of scale === 200 ? ['', 'DejaVu Sans'] : ['']) {
        const header = await headerFor(font), detail = JSON.stringify({ width, scale, header });
        expect(header.lines.length, detail).toBeGreaterThan(0);
        expect(header.touches, detail).toBe(0);
        expect(header.outside, detail).toBe(0);
        expect(header.splitWords, detail).toEqual([]);
        expect(header.height, detail).toBeLessThanOrEqual(900 * 0.25);
        // Settings never drops onto a row of its own; the stamp moves instead.
        expect(header.settingsBesideWordmark, detail).toBe(true);
        // Normal text keeps the approved single-row header.
        if (scale === 100) expect(header.sameRow, detail).toBe(true);
      }
      await expect(page.locator('.boarding-clock .badge-sched')).toHaveCount(3);
      await expect(page.locator('.destination-clock .badge-sched')).toHaveCount(3);
      await page.screenshot({ path: `test-results/garden-restored-${lang}-${theme}-${width}-${scale}.png`, fullPage: true });
      if (scale === 200) await page.locator('header.top').screenshot({ path: `test-results/garden-header-${lang}-${theme}-200.png` });
    }
    expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations).toEqual([]);
    await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; });
    const origin = page.locator('[data-end="from"] .city-control');
    await origin.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('searchbox', { name: t.cityPicker.searchCity })).toBeVisible();
    await page.getByRole('searchbox').fill('Hackensack');
    await page.locator('.city-choice').click();
    await expect(page.locator('.commute-picker input')).toHaveCount(0);
    await page.getByRole('button', { name: t.cityPicker.cancel, exact: true }).click();
    await expect(origin).toBeFocused();
    await page.getByRole('button', { name: t.journey.trainMode, exact: true }).click();
    await expect(page.getByText(t.rail.sample, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: t.journey.busMode, exact: true }).click();
    await page.getByRole('button', { name: t.settings, exact: true }).click();
    await expect(page.getByText(t.themeCleanOnly, { exact: true })).toBeVisible();
    for (const skin of ['clean','turnpike','nyc','parkway','garden'] as const) {
      await page.getByRole('button', { name: t.skins[skin], exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
      await expect(page.getByRole('button', { name: t.skins[skin], exact: true })).toHaveAttribute('aria-pressed','true');
      if (skin === 'clean') expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface').trim())).not.toBe(reference.tokens['--surface']);
    }
    await page.getByRole('button', { name: t.back, exact: true }).click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.settings.v1')!))).toEqual(initialPreferences);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1')!))).toEqual(favorites);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.penn-guide.v1.bus')!))).toMatchObject({ mode:'bus', step:3, travelling:true });
    expect(await page.evaluate(() => localStorage.getItem('arriba.lock.v1'))).toBeNull();
    await page.emulateMedia({ forcedColors: 'active' });
    await expect(page.locator('.skin-backdrop')).toBeHidden();
    expect(await page.locator('.highway-sign').first().evaluate(sign => getComputedStyle(sign).backgroundImage)).toBe('none');
    await expect(origin).toBeVisible();
  });
}
