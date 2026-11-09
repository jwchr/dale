import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { strings } from '../../src/ui/i18n';

test.use({ serviceWorkers: 'block', viewport: { width: 320, height: 780 } });
for (const lang of ['en', 'es'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`train board is first, source-qualified, keyboard usable and fits enlarged phones (${lang}, ${theme})`, async ({ page }) => {
    const t = strings[lang], j = t.journey, r = t.rail;
    await page.addInitScript(({ lang, theme }) => localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, theme, skin: 'garden' })), { lang, theme });
    await page.goto('/?now=2026-11-04T07:50');
    await page.getByRole('button', { name: j.trainMode, exact: true }).click();
    await expect(page.getByRole('img', { name: 'Dale!', exact: true })).toBeVisible();
    await expect(page.getByText(r.notice, { exact: true })).toBeVisible();
    await expect(page.locator('.journey-checklist')).not.toHaveAttribute('open');
    await expect(page.locator('.journey-help')).not.toHaveAttribute('open');
    await expect(page.getByText(j.practiceNote, { exact: true })).not.toBeVisible();
    await expect(page.getByRole('link', { name: j.tickets, includeHidden: true })).not.toBeVisible();
    await expect(page.locator('.rail-preview')).toHaveCount(1);
    await expect(page.locator('.rail-option')).toHaveCount(3);
    await expect(page.locator('.rail-option').first().locator('summary')).toContainText('PVL 1602');
    await expect(page.locator('.rail-option').first().locator('.rail-clocks strong')).toHaveText(['5:49 AM', '6:29 AM']);
    await expect(page.locator('.rail-option').first()).not.toHaveAttribute('open');
    const first = page.locator('.rail-option').first();
    await first.locator('summary').focus(); await page.keyboard.press('Enter');
    await expect(first).toHaveAttribute('open', '');
    await expect(first.getByText(r.early, { exact: true })).toBeVisible();
    await expect(first.getByText(r.arrivalTime, { exact: true })).toBeVisible();
    await first.locator('summary').press('Space');
    await expect(first).not.toHaveAttribute('open');
    await page.getByRole('button', { name: j.returning, exact: true }).click();
    await expect(page.getByRole('button', { name: j.returning, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(first.locator('.rail-clocks small').last()).toContainText(r.stationTime);
    await first.locator('summary').click();
    await expect(first.getByText(r.callTime, { exact: true })).toBeVisible();
    await first.locator('summary').click();
    await page.locator('.rail-source > summary').click();
    await expect(page.getByText(r.transferNote, { exact: true })).toBeVisible();
    await page.locator('.rail-source > summary').click();
    // Verify true default flow and real text bounds, not an overflow mask.
    for (const width of [305, 320, 390]) for (const size of [100, 130, 200]) {
      await page.setViewportSize({ width, height: 780 });
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, size);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const selector of ['.rail-clocks strong', '.rail-clocks small', '.rail-number', '.journey-controls button', '.wordmark', '.top-version']) {
        const clipped = await page.locator(selector).evaluateAll(nodes => nodes.filter(n => n.scrollWidth > n.clientWidth + 1).map(n => ({ text: n.textContent, width: n.clientWidth, scroll: n.scrollWidth })));
        expect(clipped, `${width}px ${size}% ${selector}`).toEqual([]);
      }
      const bounds = await page.locator('.top').evaluate(header => {
        const rects = [...header.children].map(n => n.getBoundingClientRect());
        return rects.every((a, i) => rects.every((b, k) => i === k || a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1));
      });
      expect(bounds).toBe(true);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; });
    await page.setViewportSize({ width: 320, height: 780 });
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `test-results/train-board-${lang}-${theme}.png`, fullPage: true });
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    const checklist = page.locator('.journey-checklist');
    await checklist.locator('summary').focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: j.next, exact: true }).click();
    await expect(page.locator('.journey-step h2')).toBeFocused();
    await page.getByRole('button', { name: j.busMode, exact: true }).click();
    await expect(page.getByRole('img', { name: 'Dale!', exact: true })).toBeVisible();
    await page.getByRole('button', { name: j.trainMode, exact: true }).click();
    await expect(page.getByRole('img', { name: 'Dale!', exact: true })).toBeVisible();
    await expect(checklist).not.toHaveAttribute('open');
    await expect(checklist.locator('summary')).toContainText(j.step(2, 5));
  });
}

// Literal source examples establish that the visible number belongs to the PVL leg,
// not necessarily to the journey's first clock. Keep this visible with all help closed.
for (const lang of ['en', 'es'] as const) for (const station of ['anderson', 'essex'] as const) {
  test(`collapsed train number names its actual boarding station in both directions (${lang}, ${station})`, async ({ page }) => {
    const t = strings[lang], j = t.journey;
    await page.addInitScript(lang => localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang })), lang);
    await page.goto('/?now=2026-11-04T07:50');
    await page.getByRole('button', { name: j.trainMode, exact: true }).click();
    await page.getByRole('combobox', { name: j.station, exact: true }).selectOption(station);
    const home = station === 'anderson' ? 'Anderson Street' : 'Essex Street (PVL, Hackensack)';
    const from = lang === 'en' ? 'from' : 'desde';
    const first = page.locator('.rail-option').first();
    await expect(first).not.toHaveAttribute('open');
    await expect(first.locator('.rail-number')).toHaveText(`PVL 1602 ${from} ${home}`);
    await expect(first.locator('.rail-clocks strong')).toHaveText([station === 'anderson' ? '5:49 AM' : '5:52 AM', '6:29 AM']);
    await page.getByRole('button', { name: j.returning, exact: true }).click();
    await expect(first).not.toHaveAttribute('open');
    await expect(first.locator('.rail-number')).toHaveText(`PVL 1605 ${from} Secaucus Junction`);
    await expect(first.locator('.rail-clocks small').first()).toContainText('New York Penn');
    await expect(first.locator('.rail-clocks strong')).toHaveText(['8:46 AM', station === 'anderson' ? '9:24 AM' : '9:21 AM']);
    await expect(first.locator('summary')).not.toContainText(`PVL 1605 ${from} New York Penn`);
    await expect(page.getByText(t.rail.notice, { exact: true })).toBeVisible();
    await expect(page.locator('.rail-source')).not.toHaveAttribute('open');
    // The source still leaves the first train's number and track unknown.
    await first.locator('summary').click();
    await expect(first.getByText(t.rail.returnBoard, { exact: true })).toBeVisible();
    await expect(first.getByText(t.rail.returnTransfer('1605', home), { exact: true })).toBeVisible();
  });
}
