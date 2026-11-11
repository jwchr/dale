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
    await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
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
    for (const [width, scale, font] of [[390, 100, ''], [305, 100, ''], [320, 130, ''], [320, 200, ''], [320, 130, 'Verdana']] as const) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate(({ scale, font }) => {
        document.documentElement.style.fontSize = `${scale}%`; document.body.style.fontFamily = font;
        // Sign names declare their own font, so the wide-font case must reach them directly.
        document.getElementById('sign-font')?.remove();
        if (font) document.head.append(Object.assign(document.createElement('style'), { id: 'sign-font', textContent: `.highway-name { font-family: ${font} !important; }` }));
      }, { scale, font });
      // Sign names re-fit in a ResizeObserver callback, which runs before the next paint: measure what a rider sees.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.locator('.commute-header').evaluate(header => {
        const box = (selector: string) => header.querySelector(selector)!.getBoundingClientRect().toJSON();
        return { left: box('[data-end="from"] .highway-sign'), right: box('[data-end="to"] .highway-sign'), stop: box('[data-end="from"] .commute-stop'), otherStop: box('[data-end="to"] .commute-stop'), reverse: box('.commute-reverse'), trigger: box('.stop-sign-toggle'), leave: box('.leave-set'), rescue: box('.rescue-chip'), overflow: document.documentElement.scrollWidth - innerWidth };
      });
      // Paired side by side where a name like HACKENSACK fits whole (390px at normal text); stacked on narrower
      // phones and enlarged text (owner request 2026-11-11: city names never split).
      if (scale === 100 && width >= 390) {
        expect(geometry.left.right).toBeLessThanOrEqual(geometry.reverse.left);
        expect(geometry.reverse.right).toBeLessThanOrEqual(geometry.right.left);
        expect(Math.abs(geometry.left.top - geometry.right.top)).toBeLessThan(1);
        expect(Math.abs(geometry.stop.top - geometry.otherStop.top)).toBeLessThan(1);
      } else {
        expect(geometry.reverse.top).toBeGreaterThanOrEqual(geometry.stop.bottom);
        expect(geometry.right.top).toBeGreaterThanOrEqual(geometry.reverse.bottom);
      }
      expect(geometry.stop.top).toBeGreaterThanOrEqual(geometry.left.bottom);
      expect(geometry.trigger.left).toBeGreaterThanOrEqual(geometry.rescue.right);
      expect(Math.abs(geometry.trigger.top - geometry.leave.top)).toBeLessThan(1);
      expect(Math.abs(geometry.trigger.top - geometry.rescue.top)).toBeLessThan(1);
      expect(geometry.trigger.height).toBeGreaterThanOrEqual(44);
      expect(geometry.reverse.height).toBeGreaterThanOrEqual(44);
      expect(geometry.overflow).toBe(0);
      // Check actual glyph runs, not only a centered box around left-aligned text.
      const names = await page.locator('.highway-name').evaluateAll(nodes => nodes.map(node => {
        const box = node.closest('.highway-sign')!.getBoundingClientRect(), lines = new Map<number, { left: number; right: number }>();
        for (const part of node.querySelectorAll('.sign-word-part')) {
          const rect = part.getBoundingClientRect(), y = Math.round(rect.top), line = lines.get(y);
          lines.set(y, { left: Math.min(line?.left ?? Infinity, rect.left), right: Math.max(line?.right ?? -Infinity, rect.right) });
        }
        const words = [...node.querySelectorAll('.sign-word')].map(word => ({ lines: new Set([...word.querySelectorAll('.sign-word-part')].map(part => Math.round(part.getBoundingClientRect().top))).size, width: [...word.querySelectorAll('.sign-word-part')].reduce((sum, part) => sum + part.getBoundingClientRect().width, 0) }));
        return { fontSize: parseFloat(getComputedStyle(node).fontSize), fitted: (node as HTMLElement).style.getPropertyValue('--sign-fit') !== '', fit: (node as HTMLElement).style.getPropertyValue('--sign-fit'), available: node.getBoundingClientRect().width, words, lineWidths: [...lines.values()].map(line => line.right - line.left),
          // Owner request 2026-11-11: centred in the green space between the From/To tag and the sign's inner edge.
          offsets: (() => { const tag = node.parentElement!.querySelector('.highway-label')!.getBoundingClientRect();
            const inner = box.right - parseFloat(getComputedStyle(node.closest('.highway-sign')!).borderRightWidth);
            return [...lines.values()].map(line => Math.abs((line.left + line.right - tag.right - inner) / 2)); })() };
      }));
      for (const name of names) {
        const detail = JSON.stringify({ width, scale, font, name });
        expect(name.offsets.every(offset => offset < 2), detail).toBe(true);
        // Owner request 2026-11-11: a city name never splits mid-word ("HACKEN / SACK") at normal and moderately enlarged text.
        // A word may break only when shrinking it to the 0.6 floor still is not enough.
        if (scale <= 130 && name.fit !== '0.6') expect(name.words.every(word => word.lines === 1), detail).toBe(true);
        // Owner request 2026-11-11: each city name on one line ("NEW YORK", not "NEW / YORK") unless it is at the 0.6 floor.
        if (scale <= 130 && name.fit !== '0.6') expect(name.lineWidths.length, detail).toBe(1);
        if (width === 390 && scale === 100 && !name.fitted) expect(name.fontSize, detail).toBeGreaterThanOrEqual(18);
      }
      // Owner request 2026-11-11: NEW YORK is the same size as HACKENSACK, and that shared size is as large as the longer name allows.
      const signDetail = JSON.stringify({ width, scale, font, names });
      expect(Math.max(...names.map(name => name.fontSize)) - Math.min(...names.map(name => name.fontSize)), signDetail).toBeLessThan(0.1);
      if (names[0].fitted && names[0].fit !== '0.6' && scale <= 130) expect(Math.max(...names.map(name => Math.max(...name.lineWidths) / name.available)), signDetail).toBeGreaterThanOrEqual(0.9);
      const tags = await page.locator('.highway-label').evaluateAll(nodes => nodes.map(node => {
        const tag = node.getBoundingClientRect(), sign = node.closest('.highway-sign')!.getBoundingClientRect();
        const name = node.parentElement!.querySelector('.highway-name')!.getBoundingClientRect();
        return { inside: tag.left >= sign.left && tag.top >= sign.top && tag.bottom <= sign.bottom, beside: tag.right <= name.left + 1, tag: tag.toJSON(), sign: sign.toJSON(), font: getComputedStyle(node).fontFamily };
      }));
      expect(tags.every(tag => tag.inside && tag.beside), JSON.stringify({ width, scale, font, tags })).toBe(true);
      // Inspect actual rendered lines: fitting boxes alone can hide isolated final letters.
      const lines = await page.locator('.highway-name, .commute-stop-name').evaluateAll(renderedSignLines);
      expect(lines.flat().filter(line => /^\p{L}$/u.test(line)), JSON.stringify({ width, scale, lines })).toEqual([]);
      await page.locator('.commute-header').screenshot({ path: `test-results/journey-${skin}-${lang}-${width}-${scale}${font ? '-' + font : ''}.png` });
    }
    await page.evaluate(() => { document.body.style.fontFamily = ''; document.getElementById('sign-font')?.remove(); document.documentElement.style.fontSize = '200%'; });
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
    // Destination city, destination stop, Leave by, alternatives, then stop sign.
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
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

// CodeRabbit on PR #141: when the town is unknown the sign shows the whole stop name. It may wrap between
// words, but it must not drag both signs to the smallest size; NEW YORK keeps the shared size on one line.
test('a long stop name without a town wraps between words and keeps the shared size readable', async ({ page }) => {
  const ds = structuredClone(liveDataset);
  ds.meta.stopCities = { state: 'verified', source: 'NJ Transit GIS Department', url: STOP_CITY_SOURCE, retrievedAt: '2026-11-04T10:00:00Z' };
  const from = ds.stops.find(stop => stop.id === '2')!;
  delete from.city;
  from.name = 'State Street at Lawrence Street';
  const favorites = [{ id: 'home', fromStopId: '2', toStopId: '3', routeIds: [], label: `${from.name} → ${ds.stops.find(stop => stop.id === '3')!.name}` }];
  await page.addInitScript(({ favorites }) => {
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ skin: 'garden', lang: 'en', theme: 'light' }));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify(favorites));
  }, { favorites });
  await page.clock.install({ time: NOW });
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', route => route.fulfill({ json: ds }));
  await page.route(API + '/v1/departures?**', route => route.abort('failed'));
  await page.goto('/?live=1');
  await expect(page.locator('.dep').first()).toBeVisible();
  await expect(page.locator('[data-end="from"] .highway-name')).toHaveText(from.name);
  for (const width of [390, 674]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const names = await page.locator('.highway-name').evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent, fit: (node as HTMLElement).style.getPropertyValue('--sign-fit'), fontSize: parseFloat(getComputedStyle(node).fontSize),
      lines: new Set([...node.querySelectorAll('.sign-word-part')].map(part => Math.round(part.getBoundingClientRect().top))).size,
      splitWords: [...node.querySelectorAll('.sign-word')].filter(word => new Set([...word.querySelectorAll('.sign-word-part')].map(part => Math.round(part.getBoundingClientRect().top))).size > 1).length,
    })));
    const detail = JSON.stringify({ width, names });
    expect(names.map(name => name.text), detail).toEqual([from.name, 'New York']);
    expect(Math.abs(names[0].fontSize - names[1].fontSize), detail).toBeLessThan(0.1);
    expect(names.every(name => name.fit !== '0.6' && name.splitWords === 0), detail).toBe(true);
    expect(names[1].lines, detail).toBe(1);
  }
});
