import { expect, test } from '@playwright/test';
import { strings } from '../../src/ui/i18n';

test.use({ serviceWorkers: 'block' });

// The inline ride view once pushed the whole page past a 305 px screen at 200% text:
// the LED board's first column sized to the unwrapped pace text, and the stop list's
// Get off here tag sat on a row that could not wrap. GitHub's runner renders with
// the wider DejaVu Sans, so the check runs with it as well as the default font.
for (const lang of ['en', 'es'] as const) for (const font of ['default', 'DejaVu Sans']) test(`ride screen fits narrow phones at large text (${lang}, ${font} font)`, async ({ page }) => {
  const t = strings[lang];
  await page.addInitScript(lang => localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light' })), lang);
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
  // Inline ride view (the full-screen view already fit).
  await page.getByRole('button', { name: t.ride.exitFull, exact: true }).click();
  if (font !== 'default') await page.addStyleTag({ content: `html, body, button, input { font-family: '${font}' !important; }` });
  const led = page.locator('.led-bar');
  await expect(led).toBeVisible();
  for (const width of [305, 320]) for (const scale of [100, 200]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
    const detail = `${lang} ${font} ${width}px ${scale}%`;
    expect(await page.evaluate(() => document.documentElement.scrollWidth), detail).toBeLessThanOrEqual(width);
    const tag = await page.locator('.ride-stops .tag-alight').boundingBox();
    expect(tag!.x + tag!.width, `${detail}: Get off here tag`).toBeLessThanOrEqual(width);
    const [bar, key, name, pace] = await Promise.all(['.led-bar', '.led-key', '.led-name', '.led-pace'].map(s => page.locator(s).boundingBox()));
    for (const box of [key, name, pace]) expect(box!.x + box!.width, detail).toBeLessThanOrEqual(bar!.x + bar!.width + 1);
    // The stop name stays readable: never squeezed to nothing.
    expect(name!.width, detail).toBeGreaterThan(40);
    // Side by side, NEXT stays left of the name, which never runs back under it (owner, #155).
    // Only when NEXT alone fills the board does the name move to its own line below.
    if (name!.y < key!.y + key!.height - 1) expect(name!.x, detail).toBeGreaterThanOrEqual(key!.x + key!.width);
    if (scale === 100) expect(name!.y, `${detail}: side by side at normal text`).toBeLessThan(key!.y + key!.height - 1);
  }
});
