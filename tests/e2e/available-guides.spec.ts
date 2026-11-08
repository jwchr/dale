import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { strings } from '../../src/ui/i18n';
const printed = JSON.parse(readFileSync(new URL('../../public/data/corridor.json', import.meta.url), 'utf8'));
test.use({ serviceWorkers: 'block' });
for (const lang of ['en', 'es'] as const) {
  const t = strings[lang], j = t.journey;
  test(`outage guides, language, checklist, Back and retry recovery (${lang})`, async ({ page }) => {
    await page.addInitScript((language) => localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: language })), lang);
    let recover = false;
    await page.route('**/data/corridor.json', (route) => recover ? route.fulfill({ json: printed }) : route.fulfill({ status: 503 }));
    await page.goto('/?now=2026-11-04T07:50');
    await expect(page.getByRole('alert')).toContainText(t.loadFailed);
    await page.getByRole('button', { name: t.guide.title, exact: true }).click();
    await expect(page.getByRole('heading', { name: t.guide.title, exact: true })).toBeFocused();
    await page.getByRole('button', { name: t.back, exact: true }).click();
    await expect(page.getByRole('button', { name: t.guide.title, exact: true })).toBeFocused();
    await page.getByRole('button', { name: j.trainMode, exact: true }).click();
    await expect(page.getByRole('heading', { name: j.title, exact: true })).toBeFocused();
    await page.getByRole('button', { name: j.next, exact: true }).click();
    await expect(page.getByText(j.step(2, 5), { exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    recover = true;
    await page.getByRole('button', { name: t.retry, exact: true }).click();
    await expect(page.getByText(t.scheduleReady)).toBeVisible();
    await expect(page.getByText(j.step(2, 5), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: t.returnToSchedule, exact: true }).click();
    await expect(page.getByRole('button', { name: j.trainMode })).toBeVisible();
    await page.getByRole('button', { name: j.trainMode }).click();
    await expect(page.getByText(j.step(2, 5), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: t.settings, exact: true }).click();
    await expect(page.getByText(t.transcribedBanner(lang === 'en' ? '7/1/2026' : '1/7/2026'), { exact: true })).toBeVisible();
    await expect(page.locator('.data-banner')).toHaveCount(0);
  });

  test(`loading does not prevent opening a guide or interrupt it when ready (${lang})`, async ({ page }) => {
    await page.addInitScript((language) => localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: language })), lang);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/data/corridor.json', async (route) => { await ready; await route.fulfill({ json: printed }); });
    await page.goto('/?now=2026-11-04T07:50');
    await page.getByRole('button', { name: j.trainMode, exact: true }).click();
    await page.getByRole('button', { name: lang === 'en' ? 'Español' : 'English', exact: true }).click();
    const other = strings[lang === 'en' ? 'es' : 'en'];
    await expect(page.locator('html')).toHaveAttribute('lang', lang === 'en' ? 'es' : 'en');
    await expect(page.getByRole('heading', { name: other.journey.title, exact: true })).toBeVisible();
    release();
    await expect(page.getByText(other.scheduleReady)).toBeVisible();
    await expect(page.getByRole('heading', { name: other.journey.title, exact: true })).toBeVisible();
    await page.getByRole('button', { name: other.back, exact: true }).click();
    await expect(page.getByRole('button', { name: other.settings, exact: true })).toBeVisible();
  });
}
