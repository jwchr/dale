// Household dashboard and bottom tab bar (#101 part 2): the LIVE pill, the direction buttons, the tabs, the map's bus
// and phone dots, and every older home feature still one tap away.
import { test, expect, type Page } from '@playwright/test';
import { liveDataset, NOW } from '../helpers/liveBus';
import { LIVE_SOURCE } from '../../src/domain/liveBus';
import { strings } from '../../src/ui/i18n';
import type { DepartureBatch, DepartureReport, DepartureRequest } from '../../src/domain/liveDepartures';

const API = 'https://dale-live.test.workers.dev';
const favorite = { id: 'dash', label: 'My commute', fromStopId: '2', toStopId: '3', routeIds: ['10'] };
type Mode = 'live' | 'gps' | 'failed' | 'cancelled';

function batch(queries: DepartureRequest[], mode: Mode, now: number): DepartureBatch {
  const observedAt = now - 20_000;
  const items: DepartureReport[] = queries.map(query => {
    if (query.tripId !== 'T1' || query.serviceDate !== '20261104') return { query };
    const gps = mode === 'gps' ? { gpsObservedAt: now - 15_000, gps: { tripInstanceId: 'T1@20261104', vehicleId: 'bus-A', observedAt: now - 15_000, lat: 40.875, lon: -74.0425 } } : {};
    const cancelled = mode === 'cancelled' ? { cancelledAt: observedAt } : {};
    return { query, updatedAt: observedAt, ...gps, ...cancelled, departure: { stopIndex: query.stopIndex, at: now + 300_000, observedAt, kind: 'departure' }, arrival: { stopIndex: query.toStopIndex, at: now + 2_400_000, observedAt, kind: 'arrival' } };
  });
  return { v: 1, source: LIVE_SOURCE, feedVersion: liveDataset.meta.feedVersion, receivedAt: now, vehicles: { state: 'ok', timestamp: now - 10_000 }, updates: { state: 'ok', timestamp: observedAt }, items };
}

async function setup(page: Page, mode: Mode, lang: 'en' | 'es' = 'en') {
  await page.clock.install({ time: NOW });
  await page.addInitScript(({ favorite, lang }) => {
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([favorite]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'household', theme: 'light', count: 3 }));
  }, { favorite, lang });
  await page.route(API + '/v1/geometry?**', r => r.abort('failed'));
  await page.route(API + '/v1/schedule', r => r.fulfill({ json: liveDataset, headers: { 'access-control-allow-origin': '*' } }));
  await page.route(API + '/v1/departures?**', r => {
    if (mode === 'failed') return r.abort('failed');
    const queries = JSON.parse(new URL(r.request().url()).searchParams.get('q')!) as DepartureRequest[];
    return r.fulfill({ json: batch(queries, mode, NOW), headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route(API + '/v1/live?**', r => r.abort('failed'));
  await page.goto('/?live=1');
  await expect(page.locator('.dep-board').first()).toBeVisible();
}

const pill = (page: Page) => page.locator('.dash-arrivals .status-pill');

test('the LIVE pill appears only when a shown bus has live NJ Transit data', async ({ page }) => {
  await setup(page, 'live');
  await expect(pill(page)).toHaveAttribute('data-live', 'true');
  await expect(pill(page)).toContainText('Live');
  // A polite status region: a switch between Scheduled and Live is announced, the board is not read out.
  await expect(pill(page)).toHaveAttribute('role', 'status');
  await expect(page.locator('.dep-boards > li[data-arrival-kind="live"]').first()).toBeVisible();
});

test('without live data the pill says SCHEDULED, never LIVE', async ({ page }) => {
  await setup(page, 'failed');
  await expect(pill(page)).toHaveAttribute('data-live', 'false');
  await expect(pill(page)).toContainText('Scheduled');
  await expect(pill(page)).not.toContainText('Live');
});

test('the direction buttons switch the saved trip between New York and New Jersey', async ({ page }) => {
  await setup(page, 'failed');
  const ny = page.getByRole('button', { name: 'To New York', exact: true }), nj = page.getByRole('button', { name: 'To New Jersey', exact: true });
  await expect(ny).toHaveAttribute('aria-pressed', 'true');
  await expect(nj).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.dash-from')).toContainText('MAIN ST');
  await nj.click();
  await expect(nj).toHaveAttribute('aria-pressed', 'true');
  await expect(ny).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.dash-from')).not.toContainText('MAIN ST');
  await ny.click();
  await expect(page.locator('.dash-from')).toContainText('MAIN ST');
});

test('every tab opens its screen, in English and Spanish', async ({ page }) => {
  await setup(page, 'failed');
  const tab = (name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true });
  await expect(tab('Dashboard')).toHaveAttribute('aria-current', 'page');
  await tab('Schedules').click();
  await expect(page.getByRole('heading', { name: 'Schedules', level: 1 })).toBeVisible();
  await expect(tab('Schedules')).toHaveAttribute('aria-current', 'page');
  await tab('Routes & stops').click();
  await expect(page.locator('#stop-search')).toBeVisible();
  await tab('PABT gates').click();
  await expect(page.getByRole('heading', { name: 'Port Authority, made simpler.', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Port Authority gates', level: 2 })).toBeVisible();
  await tab('Household').click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Español', exact: true }).click();
  const tabEs = (name: string) => page.getByRole('navigation', { name: 'Principal' }).getByRole('button', { name, exact: true });
  await expect(tabEs('Hogar')).toHaveAttribute('aria-current', 'page');
  await tabEs('Inicio').click();
  await expect(page.getByRole('heading', { name: 'Próximas llegadas' })).toBeVisible();
  await tabEs('Horarios').click();
  await expect(page.getByRole('heading', { name: 'Horarios', level: 1 })).toBeVisible();
  await tabEs('Rutas y paradas').click();
  await expect(page.locator('#stop-search')).toBeVisible();
  await tabEs('Puertas PABT').click();
  await expect(page.getByRole('heading', { name: 'Port Authority, más fácil.', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Puertas en Port Authority', level: 2 })).toBeVisible();
});

test('every older home feature is still one tap away', async ({ page }) => {
  await setup(page, 'failed');
  const card = page.getByRole('article').first();
  for (const name of ['Leave by', 'Other buses there', 'See bus stop sign']) await expect(card.getByRole('button', { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByRole('button', { name: /A little guidance/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Train' })).toBeVisible();
  await page.getByRole('button', { name: /See full-day schedules/ }).click();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.goBack().catch(() => {});
  // The train board is under Schedules too.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Schedules', exact: true }).click();
  await page.getByRole('button', { name: /^Train/ }).last().click();
  await expect(page.getByRole('heading', { name: 'Schedules', level: 1 })).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Schedules', exact: true })).toHaveAttribute('aria-current', 'page');
});

test.describe('the home map', () => {
  test.use({ geolocation: { latitude: 40.8705, longitude: -74.0402, accuracy: 20 }, permissions: ['geolocation'] });

  test('shows the official bus position and, only after a tap, the phone’s own location', async ({ page }) => {
    const sent: string[] = [];
    page.on('request', r => { if (r.method() !== 'GET' || /40\.87|74\.04/.test(r.url())) sent.push(r.url()); });
    await setup(page, 'gps');
    const bus = page.getByTestId('map-bus');
    await expect(bus).toHaveAttribute('data-live', 'true');
    await expect(page.locator('.map-bus-status')).toHaveAttribute('data-bus', 'gps');
    // The GPS dot names its source and the age of that GPS report, not of the arrival prediction.
    await expect(page.locator('.map-bus-status')).toContainText(/Position from NJ Transit, 1\d s ago\./);
    // Only the kind of dot is announced (GPS or estimate), never each new position or age.
    await expect(page.locator('.map-status > [role="status"]').first()).toHaveText(/^Bus .+: The dot is where GPS last saw the bus\.$/);
    await expect(page.getByTestId('map-you')).toHaveCount(0);
    const showMe = page.getByRole('button', { name: 'Show me on the map' });
    await expect(showMe).toHaveAttribute('aria-pressed', 'false');
    await showMe.click();
    await expect(page.getByTestId('map-you')).toBeVisible();
    await expect(showMe).toHaveAttribute('aria-pressed', 'true');
    await showMe.click();
    await expect(page.getByTestId('map-you')).toHaveCount(0);
    // The phone's location stays on the device: nothing is stored or sent.
    expect(await page.evaluate(() => Object.values(localStorage).some(v => /40\.870|74\.040/.test(v)))).toBe(false);
    expect(sent).toEqual([]);
  });

  test('without GPS the bus dot is a labeled timetable estimate', async ({ page }) => {
    await setup(page, 'failed', 'es');
    await expect(page.getByTestId('map-bus')).toHaveAttribute('data-live', 'false');
    await expect(page.locator('.map-bus-status')).toHaveAttribute('data-bus', 'estimate');
    await expect(page.locator('.map-bus-status')).toContainText(/estimad/i);
    await expect(page.locator('.map-status > [role="status"]').first()).toHaveText(/^Autobús .+: .*estimad/i);
  });

  // A phone fix the line map can't use: too old, or too imprecise. Mocked in the page; nothing leaves the device.
  const phoneFix = (page: Page, fix: { accuracy: number; ageMs: number }) => page.addInitScript(({ accuracy, ageMs }) => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      watchPosition: (ok: PositionCallback) => { setTimeout(() => ok({ coords: { latitude: 40.8705, longitude: -74.0402, accuracy }, timestamp: Date.now() - ageMs } as GeolocationPosition), 50); return 1; },
      clearWatch: () => {}, getCurrentPosition: () => {},
    } });
  }, fix);

  for (const lang of ['en', 'es'] as const) {
    const s = lang === 'en'
      ? { showMe: 'Show me on the map', waiting: 'Waiting for a new location from your phone.', cannot: 'The line map can’t place your location on this route right now.', offRoute: /not near/i }
      : { showMe: 'Mostrarme en el mapa', waiting: 'Esperando una nueva ubicación de tu teléfono.', cannot: 'El mapa de la línea no puede ubicarte en esta ruta ahora mismo.', offRoute: /no estás cerca/i };

    test(`an expired phone fix leaves the map until a new one arrives (${lang})`, async ({ page }) => {
      await phoneFix(page, { accuracy: 20, ageMs: 10 * 60_000 });
      await setup(page, 'gps', lang);
      await page.getByRole('button', { name: s.showMe }).click();
      await expect(page.locator('.map-you-status')).toHaveText(s.waiting);
      await expect(page.locator('.map-you-status + [role="status"], .map-you-status ~ [role="status"]').first()).toHaveText(s.waiting);
      await expect(page.getByTestId('map-you')).toHaveCount(0);
      await expect(page.locator('.map-key-you')).toHaveCount(0);
    });

    test(`an imprecise phone fix is not called off-route (${lang})`, async ({ page }) => {
      await phoneFix(page, { accuracy: 500, ageMs: 0 });
      await setup(page, 'gps', lang);
      await page.getByRole('button', { name: s.showMe }).click();
      await expect(page.locator('.map-you-status')).toContainText(s.cannot);
      await expect(page.locator('.map-you-status')).not.toContainText(s.offRoute);
      await expect(page.getByTestId('map-you')).toHaveCount(0);
    });
  }
});

test('a cancelled next bus stays on the board but is not drawn as the rider’s connection', async ({ page }) => {
  await setup(page, 'cancelled');
  await expect(page.locator('.dep-board').first()).toHaveAttribute('data-cancelled', 'true');
  const connection = page.locator('.dash-connection');
  // The fixture's next bus after the cancelled one carries the connection instead.
  await expect(connection).toHaveAttribute('data-trip', /.+/);
  await expect(connection).not.toHaveAttribute('data-trip', 'T1@20261104');
});

for (const lang of ['en', 'es'] as const) test(`PABT gates keep trips with different buses apart and date tomorrow’s buses (${lang})`, async ({ page }) => {
  await page.addInitScript((lang) => {
    localStorage.setItem('arriba.favorites.v1', JSON.stringify([
      { id: 'a', label: 'Local', fromStopId: 'PABT', toStopId: 'W10', routeIds: ['R165'] },
      { id: 'b', label: 'Turnpike', fromStopId: 'PABT', toStopId: 'W10', routeIds: ['R165T'] }]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'household', count: 3, tourSeen: true }));
  }, lang);
  await page.goto('/?printed=1&now=2026-11-04T23:58');
  await page.getByRole('navigation', { name: lang === 'en' ? 'Main' : 'Principal' }).getByRole('button', { name: lang === 'en' ? 'PABT gates' : 'Puertas PABT', exact: true }).click();
  const trips = page.locator('.gate-trip');
  await expect(trips).toHaveCount(2);
  await expect(trips.nth(0).locator('h3')).toHaveText(/\(165\)$/);
  await expect(trips.nth(1).locator('h3')).toHaveText(/\(165T\)$/);
  // After tonight's last bus, the next ones are tomorrow's, and each says so.
  const date = trips.nth(0).locator('.gate-row .dep-date').first();
  await expect(date).toBeVisible();
  await expect(date).toHaveText(lang === 'en' ? '11/5/2026' : '5/11/2026');
});

for (const lang of ['en', 'es'] as const) test(`PABT gate guide: three steps, honest gate notice, walk-through and official links (${lang})`, async ({ page }) => {
  await page.addInitScript((lang) => {
    localStorage.setItem('arriba.favorites.v1', JSON.stringify([{ id: 'a', label: 'Local', fromStopId: 'PABT', toStopId: 'W10', routeIds: ['R165'] }]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'household', count: 3, tourSeen: true }));
  }, lang);
  await page.goto('/?printed=1&now=2026-11-04T17:00');
  await page.getByRole('navigation', { name: lang === 'en' ? 'Main' : 'Principal' }).getByRole('button', { name: lang === 'en' ? 'PABT gates' : 'Puertas PABT', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: lang === 'en' ? 'Port Authority, made simpler.' : 'Port Authority, más fácil.' })).toBeVisible();
  const steps = page.locator('.gg-steps > li');
  await expect(steps).toHaveCount(3);
  // The gate sign in the third picture is translated and never carries a gate number.
  await expect(steps.nth(2).locator('.gg-icon text')).toHaveText(lang === 'en' ? 'GATE' : 'PUERTA');
  await expect(steps.nth(0)).toContainText(lang === 'en' ? 'Find your departure' : 'Encuentra tu salida');
  await expect(page.locator('.gg-num')).toHaveText(['01', '02', '03']);
  // The gate icon never shows a number.
  await expect(page.locator('.gg-icon').nth(2)).not.toContainText(/\d/);
  // The notice shows exactly when none of the listed buses has a sourced gate.
  const known = await page.locator('.gate-row .dep-gate:not([data-status="unknown"])').count();
  await expect(page.locator('.gg-notice')).toHaveCount(known ? 0 : 1);
  await expect(page.getByRole('link', { name: lang === 'en' ? 'Open official terminal information' : 'Abrir la información oficial de la terminal' }))
    .toHaveAttribute('href', 'https://www.panynj.gov/bus-terminals/en/port-authority.html');
  await expect(page.getByRole('link', { name: lang === 'en' ? 'NJ Transit app & tickets' : 'App y boletos de NJ Transit' })).toHaveAttribute('href', 'https://www.njtransit.com/app');
  // Nothing spills sideways on a narrow phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: lang === 'en' ? 'Walk me through it' : 'Guíame paso a paso' }).click();
  await expect(page.locator('.guide h1')).toBeVisible();
});

for (const lang of ['en', 'es'] as const) test(`Routes & stops: the saved stop, its routes, a route filter and the next buses with a lock button (${lang})`, async ({ page }) => {
  const t = strings[lang], r = t.dash.routes;
  await page.addInitScript((lang) => {
    localStorage.setItem('arriba.favorites.v1', JSON.stringify([{ id: 'a', label: 'Local', fromStopId: 'PABT', toStopId: 'W10', routeIds: ['R165'] }]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'household', count: 3, tourSeen: true }));
  }, lang);
  await page.goto('/?printed=1&now=2026-11-04T17:30');
  await page.getByRole('navigation', { name: t.dash.tabs.label }).getByRole('button', { name: t.dash.tabs.routes, exact: true }).click();
  const card = page.locator('.routes-stop');
  await expect(card.getByRole('heading', { level: 2 })).toHaveText(/Port Authority/);
  await expect(page.getByRole('group', { name: t.dash.direction })).toBeVisible();
  // Every route the printed timetable runs from this stop to the saved one, counted, never guessed.
  const filter = card.getByRole('combobox', { name: r.filter });
  await expect(filter.locator('option')).toHaveText([r.allRoutes(2), '165', '165T']);
  const rows = card.locator('.routes-boards > li');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText(r.scheduled);
  await filter.selectOption({ label: '165' });
  await expect(rows.first().locator('.dep-board')).toContainText('165');
  await expect(rows.locator('.dep-board', { hasText: '165T' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: r.fullDayFor(t.dash.portAuthority) })).toBeVisible();
  // The lock button opens that exact bus's trip screen, where the rider confirms the lock.
  await rows.first().getByRole('button', { name: t.lockBus }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('button', { name: t.lockBus, exact: true })).toBeVisible();
});
