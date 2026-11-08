import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { liveDataset, NOW } from '../helpers/liveBus';
import { STOP_CITY_SOURCE } from '../../src/domain/stopInfo';
import { strings } from '../../src/ui/i18n';

// Read text by its real rendered line, including spans used for oversized words.
const renderedSignLines = (nodes: Element[]) => nodes.map(node => {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const lines = new Map<number, string>();
  let text: Node | null;
  while ((text = walker.nextNode())) {
    for (let index = 0; index < (text.textContent?.length ?? 0); index++) {
      const range = document.createRange();
      range.setStart(text, index); range.setEnd(text, index + 1);
      const y = Math.round(range.getBoundingClientRect().top);
      lines.set(y, (lines.get(y) ?? '') + text.textContent![index]);
    }
  }
  return [...lines.values()].map(line => line.trim()).filter(Boolean);
});

const API = 'https://dale-live.test.workers.dev';
for (const skin of ['turnpike', 'parkway', 'nyc', 'garden', 'clean']) {
  for (const lang of ['en', 'es'] as const) test(`paired journey signs and adjacent actions (${skin}, ${lang})`, async ({ page }) => {
    const t = strings[lang], ds = structuredClone(liveDataset);
    ds.meta.stopCities = { state: 'verified', source: 'NJ Transit GIS Department', url: STOP_CITY_SOURCE, retrievedAt: '2026-11-04T10:00:00Z' };
    const from = ds.stops.find(stop => stop.id === '2')!;
    from.city = 'Hackensack';
    from.name = 'State Street at Lawrence Street';
    const favorites = [{ id: 'home', fromStopId: '2', toStopId: '3', routeIds: [], label: `${from.name} → ${ds.stops.find(stop => stop.id === '3')!.name}` }];
    await page.addInitScript(({ skin, lang, favorites }) => {
      localStorage.setItem('arriba.settings.v1', JSON.stringify({ skin, lang, theme: 'light' }));
      localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify(favorites));
    }, { skin, lang, favorites });
    await page.clock.install({ time: NOW });
    await page.route(API + '/v1/schedule', route => route.fulfill({ json: ds }));
    await page.route(API + '/v1/departures?**', route => route.abort('failed'));
    await page.goto('/?live=1');
    await expect(page.locator('.dep').first()).toBeVisible();
    const left = page.locator('[data-end="from"]'), right = page.locator('[data-end="to"]');
    await expect(left.locator('.highway-name')).toHaveText('Hackensack');
    await expect(left.locator('.commute-stop')).toHaveText(from.name);
    await expect(right.locator('.highway-name')).toHaveText(t.commuteNewYork);
    await expect(right.locator('.commute-stop')).toHaveText(t.commutePabt);
    const trigger = page.getByRole('button', { name: t.stopSign.open, exact: true });
    const reverse = page.getByRole('button', { name: t.reverse, exact: true });
    for (const [width, scale] of [[390, 100], [305, 100], [320, 130], [320, 200]] as const) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
      const geometry = await page.locator('.commute-header').evaluate(header => {
        const box = (selector: string) => header.querySelector(selector)!.getBoundingClientRect().toJSON();
        return { left: box('[data-end="from"] .highway-sign'), right: box('[data-end="to"] .highway-sign'), stop: box('[data-end="from"] .commute-stop'), otherStop: box('[data-end="to"] .commute-stop'), reverse: box('.commute-reverse'), trigger: box('.stop-sign-toggle'), overflow: document.documentElement.scrollWidth - innerWidth };
      });
      expect(geometry.left.right).toBeLessThan(geometry.right.left);
      expect(Math.abs(geometry.left.top - geometry.right.top)).toBeLessThan(1);
      expect(Math.abs(geometry.stop.top - geometry.otherStop.top)).toBeLessThan(1);
      expect(geometry.stop.top).toBeGreaterThanOrEqual(geometry.left.bottom);
      expect(geometry.trigger.left).toBeGreaterThan(geometry.reverse.right);
      expect(Math.abs((geometry.trigger.top + geometry.trigger.bottom) / 2 - (geometry.reverse.top + geometry.reverse.bottom) / 2)).toBeLessThan(1);
      expect(geometry.trigger.height).toBeGreaterThanOrEqual(44);
      expect(geometry.reverse.height).toBeGreaterThanOrEqual(44);
      expect(geometry.overflow).toBe(0);
      // Inspect actual rendered lines: fitting boxes alone can hide isolated final letters.
      const lines = await page.locator('.highway-name, .commute-stop-name').evaluateAll(renderedSignLines);
      expect(lines.flat().filter(line => /^\p{L}$/u.test(line)), JSON.stringify({ width, scale, lines })).toEqual([]);
      await page.locator('.commute-header').screenshot({ path: `test-results/journey-${skin}-${lang}-${width}-${scale}.png` });
    }
    await expect(left.locator('.highway-name')).toMatchAriaSnapshot('- strong: Hackensack');
    await expect(right.locator('.highway-name')).toMatchAriaSnapshot(`- strong: ${t.commuteNewYork}`);
    await trigger.scrollIntoViewIfNeeded();
    // A tall pill can contain text geometrically while curved corners exclude its final letters.
    const containment = async (font: string) => {
      await expect.poll(() => page.locator('header.top').evaluate(header => {
        const gap = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) - header.getBoundingClientRect().height;
        return gap >= 0 && gap <= 12;
      })).toBe(true);
      await trigger.scrollIntoViewIfNeeded();
      const observed = await trigger.evaluate(button => {
        const range = document.createRange(); range.selectNodeContents(button);
        const points = [...range.getClientRects()].filter(line => line.width > 0 && line.height > 0).flatMap(line =>
          [line.left + 1, line.right - 1].map(x => {
            const y = line.bottom - 1, hit = document.elementFromPoint(x, y);
            return { x, y, contained: button.contains(hit), hit: hit?.tagName, hitClass: hit?.getAttribute('class') };
          }));
        return { points, button: button.getBoundingClientRect().toJSON(), header: document.querySelector('header.top')!.getBoundingClientRect().toJSON(), scrollY, viewportHeight: innerHeight };
      });
      expect(observed.points.every(point => point.contained), JSON.stringify({ font, observed })).toBe(true);
    };
    await containment('native');
    if (skin === 'turnpike' && lang === 'es') {
      await trigger.evaluate(button => button.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await containment('start-aligned-scroll');
    }
    if (skin === 'turnpike' && lang === 'es') {
      for (const font of ['Arial', 'Verdana']) {
        await page.evaluate(font => { document.body.style.fontFamily = font; }, font);
        await containment(font);
      }
      await page.evaluate(() => { document.body.style.fontFamily = ''; });
    }
    await reverse.focus();
    await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.stop-sign')).toBeVisible();
    await expect(page.locator('.stop-sign')).toHaveAttribute('id', (await trigger.getAttribute('aria-controls'))!);
    await trigger.tap();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.stop-sign')).toBeHidden();
    if (skin === 'clean') expect((await new AxeBuilder({ page }).include('.commute-header').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await reverse.focus();
    await page.keyboard.press('Enter');
    await expect(left.locator('.highway-name')).toHaveText(t.commuteNewYork);
    await expect(reverse).toHaveAttribute('aria-pressed', 'true');
    await expect(reverse).toBeFocused();
    await page.getByRole('button', { name: t.reverse, exact: true }).click();
    await expect(left.locator('.highway-name')).toHaveText('Hackensack');
    await expect(reverse).toHaveAttribute('aria-pressed', 'false');
    await expect(reverse).toBeFocused();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1.g2')!))).toEqual(favorites);
    if (skin === 'garden' && lang === 'es') {
      from.city = 'Peñañ'; // Non-ASCII final letter must not escape the orphan guard.
      await page.reload();
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await expect(left.locator('.highway-name')).toHaveText('Peñañ');
      await expect(left.locator('.highway-name')).toMatchAriaSnapshot('- strong: Peñañ');
      const lines = await left.locator('.highway-name').evaluateAll(renderedSignLines);
      expect(lines.flat().filter(line => /^\p{L}$/u.test(line)), JSON.stringify(lines)).toEqual([]);
    }
  });
}
