import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const printed = JSON.parse(readFileSync(new URL('../../public/data/corridor.json', import.meta.url), 'utf8'));
test.use({ serviceWorkers: 'block' });

for (const lang of ['en', 'es'] as const) {
  const settings = lang === 'en' ? 'Settings' : 'Ajustes';
  const retry = lang === 'en' ? 'Try again' : 'Intentar de nuevo';
  const failed = lang === 'en' ? "Couldn't load the schedule" : 'No se pudo cargar el horario';

  test(`damaged saved commutes do not hide good commutes or Settings (${lang})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((language) => {
      localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: language }));
      const good = { id: 'good', label: 'My weekday bus', fromStopId: 'N19', toStopId: 'PABT', routeIds: [] };
      localStorage.setItem('arriba.favorites.v1', JSON.stringify([{ ...good, id: 'bad', label: {} }, good, { id: 'incomplete' }]));
    }, lang);
    await page.goto('/?printed=1&now=2026-11-04T07:50');
    const card = page.getByRole('article', { name: /My weekday bus/ });
    await expect(card).toBeVisible();
    await expect(card.locator('.dep')).toHaveCount(3);
    await page.getByRole('button', { name: settings, exact: true }).click();
    await expect(page.getByRole('heading', { name: settings, exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1')!).map((f: { id: string }) => f.id))).toEqual(['good']);
    expect(errors).toEqual([]);
  });

  for (const [name, broken] of [
    ['incomplete structure', { trips: [{}] }],
    ['invalid timezone', { ...printed, meta: { ...printed.meta, timezone: 'Not/A_timezone' } }],
    ['broken trip reference', { ...printed, trips: [{ ...printed.trips[0], patternId: 'missing-pattern' }] }],
  ] as const) {
    test(`invalid schedule shows Retry, then restores saved-copy provenance: ${name} (${lang})`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((language) => localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: language })), lang);
      let recover = false;
      await page.route('**/data/corridor.json', (route) => route.fulfill({
        json: recover ? printed : broken,
        headers: { 'x-arriba-from-cache': '1', 'x-arriba-saved-at': String(Date.parse('2026-11-04T12:30:00Z')) },
      }));
      await page.goto('/?printed=1&now=2026-11-04T07:50');
      await expect(page.getByRole('alert')).toContainText(failed);
      await expect(page.locator('.demo-banner')).toHaveCount(0);
      recover = true;
      await page.getByRole('button', { name: retry, exact: true }).click();
      await expect(page.getByRole('button', { name: settings, exact: true })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.locator('.status-line')).toContainText(lang === 'en' ? 'schedule saved 11/4/2026, 7:30 AM' : 'horario guardado el 4/11/2026, 7:30');
      await expect(page.locator('.demo-banner')).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
}
