import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Automated accessibility check (axe-core, WCAG 2.1 A and AA rules) on each screen, light and dark, English and Spanish.
// It cannot judge everything (reading order, plain language); it catches contrast, names, roles and labels.

// The service worker would answer a blocked load from its saved copy; the other suites block it too.
test.use({ serviceWorkers: 'block' });

async function audit(page: Page, screen: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = violations.map((v) => `${screen}: ${v.id} (${v.impact}) × ${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(summary, summary.join('\n')).toEqual([]);
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const lang of ['en', 'es'] as const) {
    test(`screens pass axe, ${colorScheme}, ${lang}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto('/?now=2026-11-04T17:10');
      if (lang === 'es') {
        await page.getByRole('button', { name: 'Settings' }).click();
        await page.getByRole('button', { name: 'Español' }).click();
        await page.getByRole('button', { name: 'Atrás' }).click();
      }
      const t = lang === 'es'
        ? { find: /Buscar parada/i, save: /Guardar/, reverse: /Invertir/, allDay: /Todo el día/, settings: 'Ajustes', back: 'Atrás', guide: '¿Primera vez? Cómo funciona' }
        : { find: /Find a stop/i, save: 'Save trip', reverse: /Reverse/, allDay: /All day/, settings: 'Settings', back: 'Back', guide: 'First time riding? How it works' };
      await audit(page, 'home (empty)');
      await page.getByRole('button', { name: t.find }).first().click();
      await page.getByRole('searchbox').fill('irvington');
      await audit(page, 'search');
      await page.getByRole('button', { name: /Irvington St\. \(to New York\)/ }).click();
      await audit(page, 'destinations');
      await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
      await page.getByRole('button', { name: t.save }).first().click();
      await page.getByRole('button', { name: t.reverse }).click();
      await audit(page, 'home (commute, from Port Authority)');
      await page.locator('.dep').first().click();
      await audit(page, 'trip');
      await page.getByRole('button', { name: t.back }).click();
      await page.getByRole('button', { name: t.allDay }).click();
      await audit(page, 'timetable');
      await page.getByRole('button', { name: t.settings }).click();
      await audit(page, 'settings');
      await page.getByRole('button', { name: t.guide }).click();
      await audit(page, 'guide');
    });
  }
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`demo, warnings, edit mode and the load error pass axe, ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto('/?now=2026-11-04T07:50&demo');
    await page.getByRole('button', { name: /Find a stop/i }).first().click();
    await page.getByRole('searchbox').fill('maple');
    await page.getByRole('button', { name: /Maple Ave & Main St \(to Demo Terminal\)/ }).click();
    await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
    await audit(page, 'demo wrong-side warning');
    await page.getByRole('button', { name: 'Use that stop' }).click();
    await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.getByRole('button', { name: /Reverse/ }).click();
    await audit(page, 'demo home');
    await page.locator('.dep').first().click();
    await audit(page, 'demo trip with usual gate');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Edit' }).click();
    await audit(page, 'edit mode');

    await page.route('**/data/corridor.json', (route) => route.abort('internetdisconnected'));
    await page.goto('/?now=2026-11-04T07:50');
    await expect(page.getByRole('alert')).toBeVisible();
    await audit(page, 'load error');
  });
}

// Each style (owner request 2026-11-04, D46) on the main screens: home with a commute, a trip, the timetable, Settings.
for (const [skin, colorScheme] of [['garden', 'light'], ['garden', 'dark'], ['clean', 'light'], ['clean', 'dark'], ['parkway', 'dark'], ['nyc', 'dark'], ['turnpike', 'light']] as const) {
  test(`style ${skin} (${colorScheme}) passes axe on the main screens`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.addInitScript((s) => { try { localStorage.setItem('arriba.settings.v1', JSON.stringify({ skin: s })); } catch { /* ignore */ } }, skin);
    await page.goto('/?now=2026-11-04T17:10');
    await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
    await expect(page.locator('.skin-backdrop')).toHaveCount(1);
    await page.getByRole('button', { name: /Find a stop/i }).first().click();
    await page.getByRole('searchbox').fill('irvington');
    await page.getByRole('button', { name: /Irvington St\. \(to New York\)/ }).click();
    await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await audit(page, `${skin} home`);
    await page.locator('.dep').first().click();
    await audit(page, `${skin} trip`);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: /All day/ }).click();
    await audit(page, `${skin} timetable`);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('button', { name: { garden: 'Garden State', clean: 'Clean', parkway: 'Parkway', nyc: 'NYC night', turnpike: 'Turnpike' }[skin] })).toHaveAttribute('aria-pressed', 'true');
    await audit(page, `${skin} settings`);
  });
}
