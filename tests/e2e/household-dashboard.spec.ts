// Household dashboard and bottom tab bar (#101 part 2): the LIVE pill, the direction buttons, the tabs, the map's bus
// and phone dots, and every older home feature still one tap away.
import { test, expect, type Page } from '@playwright/test';
import { liveDataset, NOW } from '../helpers/liveBus';
import { LIVE_SOURCE } from '../../src/domain/liveBus';
import type { DepartureBatch, DepartureReport, DepartureRequest } from '../../src/domain/liveDepartures';

const API = 'https://dale-live.test.workers.dev';
const favorite = { id: 'dash', label: 'My commute', fromStopId: '2', toStopId: '3', routeIds: ['10'] };
type Mode = 'live' | 'gps' | 'failed';

function batch(queries: DepartureRequest[], mode: Mode, now: number): DepartureBatch {
  const observedAt = now - 20_000;
  const items: DepartureReport[] = queries.map(query => {
    if (query.tripId !== 'T1' || query.serviceDate !== '20261104') return { query };
    const gps = mode === 'gps' ? { gpsObservedAt: now - 15_000, gps: { tripInstanceId: 'T1@20261104', vehicleId: 'bus-A', observedAt: now - 15_000, lat: 40.875, lon: -74.0425 } } : {};
    return { query, updatedAt: observedAt, ...gps, departure: { stopIndex: query.stopIndex, at: now + 300_000, observedAt, kind: 'departure' }, arrival: { stopIndex: query.toStopIndex, at: now + 2_400_000, observedAt, kind: 'arrival' } };
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
  await expect(page.getByRole('heading', { name: 'Port Authority gates', level: 1 })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Puertas en Port Authority', level: 1 })).toBeVisible();
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
  });
});
