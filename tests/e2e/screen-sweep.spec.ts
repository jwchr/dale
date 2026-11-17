import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { strings } from '../../src/ui/i18n';

test.use({ serviceWorkers: 'block' });

// One sweep of the main screens (#153 items 13 and 14) with the font GitHub's runner uses. DejaVu Sans is
// wider than the local default font, so a screen can pass locally and overflow in CI (#174). Each screen is
// checked at 305 and 320 px with 200% text, in English and Spanish, plus an accessibility scan at normal size.
const FONT = `html, body, button, input, select, textarea { font-family: 'DejaVu Sans' !important; }`;

type Screen = { name: string; open: (page: Page, lang: 'en' | 'es') => Promise<void> };

async function start(page: Page, lang: 'en' | 'es') {
  await page.addInitScript((l) => localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang: l, skin: 'clean', theme: 'light' })), lang);
  await page.goto('/?printed=1&now=2026-11-04T07:50');
  await page.addStyleTag({ content: FONT });
}

async function savedTrip(page: Page, lang: 'en' | 'es') {
  const t = strings[lang];
  await start(page, lang);
  await page.getByRole('button', { name: t.findStop, exact: true }).first().click();
  await page.getByRole('searchbox').fill('irvington');
  await page.getByRole('button', { name: /Irvington St\./ }).first().click();
  await page.getByRole('button', { name: /Port Authority Bus Terminal/i }).first().click();
  await page.getByRole('button', { name: t.selection.save, exact: true }).first().click();
}

const screens: Screen[] = [
  { name: 'home', open: start },
  { name: 'find a stop', open: async (page, lang) => { await start(page, lang); await page.getByRole('button', { name: strings[lang].findStop, exact: true }).first().click(); } },
  { name: 'saved trip', open: savedTrip },
  { name: 'trip and bus lock', open: async (page, lang) => { await savedTrip(page, lang); await page.locator('.dep').first().click(); } },
  { name: 'settings', open: async (page, lang) => { await start(page, lang); await page.getByRole('button', { name: strings[lang].settings, exact: true }).click(); } },
  { name: 'train', open: async (page, lang) => { await start(page, lang); await page.getByRole('button', { name: lang === 'es' ? 'Tren' : 'Train', exact: true }).click(); } },
];

for (const lang of ['en', 'es'] as const) for (const screen of screens) {
  test(`${screen.name} fits narrow phones at 200% text in GitHub's font (${lang})`, async ({ page }) => {
    await screen.open(page, lang);
    for (const width of [305, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      const over = await page.evaluate((w) => {
        const wide = document.documentElement.scrollWidth;
        if (wide <= w) return null;
        // Name the deepest visible elements that stick out, so a failure says where to look.
        const out = [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > w + 1 && ![...el.children].some((c) => (c as HTMLElement).getBoundingClientRect().right > w + 1);
        }).slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent ?? '').trim().slice(0, 30)}"`);
        return { wide, out };
      }, width);
      expect(over, `${screen.name} ${lang} ${width}px`).toBeNull();
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await page.setViewportSize({ width: 412, height: 915 });
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`), `${screen.name} ${lang}`).toEqual([]);
  });
}
