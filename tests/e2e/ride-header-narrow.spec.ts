import { expect, test } from '@playwright/test';
import { strings } from '../../src/ui/i18n';

// Full-screen ride view with bilingual buttons off (the default): "Exit full screen" must stay on a
// 305/320 px phone at 200% text in both languages, and the dialog must not scroll sideways.
for (const lang of ['en', 'es'] as const) test(`full-screen ride view fits narrow phones at 200% text (${lang})`, async ({ page }) => {
  const t = strings[lang];
  await page.addInitScript((l) => localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: l, skin: 'clean', theme: 'light' })), lang);
  await page.goto('/?now=2026-11-04T07:50&demo');
  await page.getByRole('button', { name: t.findStop, exact: true }).first().click();
  await page.getByRole('searchbox').fill('90002');
  await page.getByRole('button', { name: /Maple Ave & Main St \(to NYC\)/ }).click();
  await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
  await page.getByRole('button', { name: t.selection.save, exact: true }).first().click();
  await page.locator('.dep').first().click();
  await page.getByRole('button', { name: t.lockBus, exact: true }).click();
  await page.getByRole('button', { name: t.busLock.begin, exact: true }).click();
  await page.getByRole('button', { name: t.busLock.arrived, exact: true }).click();
  await page.getByRole('button', { name: t.busLock.boarded, exact: true }).click();
  const ride = page.getByRole('dialog');
  // A wide fallback font as well, since Mac and Linux font metrics differ.
  await page.addStyleTag({ content: '.ride-top { font-family: monospace; }' });
  for (const width of [305, 320]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    const exit = ride.getByRole('button', { name: t.ride.exitFull, exact: true });
    const box = (await exit.boundingBox())!;
    expect(box.x, `${lang} ${width}px`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${lang} ${width}px`).toBeLessThanOrEqual(width + 1);
    // Name what sticks out, so a failure says where to look.
    const over = await ride.evaluate((d) => {
      if (d.scrollWidth - d.clientWidth <= 1) return null;
      const edge = d.getBoundingClientRect().right;
      return [...d.querySelectorAll<HTMLElement>('*')].filter((el) => {
        const r = el.getBoundingClientRect();
        // Content inside its own sideways scroller (the route strip) is contained there and does not count.
        for (let p = el.parentElement; p && p !== d; p = p.parentElement) if (['auto', 'scroll'].includes(getComputedStyle(p).overflowX)) return false;
        return r.width > 0 && r.right > edge + 1 && ![...el.children].some((c) => (c as HTMLElement).getBoundingClientRect().right > edge + 1);
      }).slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent ?? '').trim().slice(0, 30)}"`);
    });
    expect(over, `${lang} ${width}px`).toBeNull();
  }
});
