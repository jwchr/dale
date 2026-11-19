import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { strings } from '../../src/ui/i18n';

test.use({ serviceWorkers: 'block' });
for (const lang of ['en', 'es'] as const) for (const skin of ['household', 'garden', 'turnpike', 'parkway', 'nyc', 'clean']) test(`saved-bus actions fit enlarged phones and retain native behavior (${lang}, ${skin})`, async ({ page }) => {
  const t = strings[lang];
  await page.addInitScript(({ lang, skin }) => {
    if (!localStorage.getItem('arriba.settings.v1')) localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin, theme: 'light' }));
  }, { lang, skin });
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await page.getByRole('button', { name: t.findStop, exact: true }).click();
  await page.getByRole('searchbox').fill('irvington');
  await page.getByRole('button', { name: /Irvington St\. \(to New York\)/ }).click();
  await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
  await page.getByRole('button', { name: t.selection.save, exact: true }).first().click();
  await page.locator('.dep').first().click();
  await page.getByRole('button', { name: t.lockBus, exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!localStorage.getItem('arriba.lock.v1'))).toBe(true);
  const before = await page.evaluate(() => ({ favorite: localStorage.getItem('arriba.favorites.v1'), lock: JSON.parse(localStorage.getItem('arriba.lock.v1')!) }));
  await page.reload();
  const banner = page.locator('.lock-return[role=note]');
  await expect(banner).toBeVisible();
  await page.getByRole('button', { name: t.settings, exact: true }).click();
  for (const width of [305, 320]) for (const enlarged of [false, true]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(enlarged => {
      document.documentElement.style.fontSize = enlarged ? '200%' : '100%';
      document.body.style.fontSize = enlarged ? '32px' : '';
    }, enlarged);
    const geometry = await banner.evaluate(element => {
      const parent = element.getBoundingClientRect(), buttons = [...element.querySelectorAll('button')].map(b => b.getBoundingClientRect());
      return { viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth,
        controls: buttons.map(b => ({left:b.left,right:b.right,height:b.height})),
        inside: buttons.every(b => b.left >= parent.left && b.right <= parent.right && b.right <= document.documentElement.clientWidth),
        separate: buttons.length === 2 && (buttons[0]!.right <= buttons[1]!.left || buttons[0]!.bottom <= buttons[1]!.top),
      };
    });
    expect(geometry.inside, JSON.stringify(geometry)).toBe(true);
    expect(geometry.separate).toBe(true);
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
    for (const control of geometry.controls) expect(control.height).toBeGreaterThanOrEqual(44);
    const resume = banner.getByRole('button', { name: t.busLock.resumeYes, exact: true });
    await resume.focus(); await expect(resume).toBeFocused(); await page.keyboard.press('Tab');
    await expect(banner.getByRole('button', { name: t.busLock.resumeNo, exact: true })).toBeFocused();
  }
  expect((await new AxeBuilder({ page }).include('.lock-return').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  if (skin === 'garden') await banner.screenshot({ path: `test-results/resume-banner-${lang}.png` });
  expect(await page.evaluate(() => localStorage.getItem('arriba.favorites.v1'))).toBe(before.favorite);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.lock.v1')!))).toEqual(before.lock);
  await banner.getByRole('button', { name: t.busLock.resumeYes, exact: true }).click();
  await expect(banner).toHaveCount(0); await expect(page.locator('.bus-lock')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.lock.v1')!))).toMatchObject({ dep: before.lock.dep, leg: before.lock.leg, session: { id: before.lock.session.id, lock: { tripInstanceId: before.lock.session.lock.tripInstanceId } } });
  await page.reload();
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: t.busLock.resumeNo, exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(banner).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('arriba.lock.v1'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('arriba.favorites.v1'))).toBe(before.favorite);
});
