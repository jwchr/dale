import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { liveDataset, NOW } from '../helpers/liveBus';
import { LIVE_SOURCE, type LiveBusSnapshot } from '../../src/domain/liveBus';

const API = 'https://dale-live.test.workers.dev';
const oldFavorite = { id: 'old', label: 'My printed commute', fromStopId: 'N10', toStopId: 'N20', routeIds: ['165T'] };
async function setup(page: Page, response: () => LiveBusSnapshot | null | Promise<LiveBusSnapshot | null>, lang = 'en', wallTime = NOW, pinned = false) {
  await page.clock.install({ time: wallTime });
  await page.addInitScript(({ favorite, lang }) => {
    localStorage.setItem('arriba.favorites.v1', JSON.stringify([favorite]));
    localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'live-test', label: 'My live bus', fromStopId: '2', toStopId: '3', routeIds: ['10'] }]));
    localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light', count: 3 }));
  }, { favorite: oldFavorite, lang });
  await page.route(API + '/v1/departures?**', (route) => route.abort('failed'));
  await page.route(API + '/v1/schedule', (route) => route.fulfill({ json: liveDataset, headers: { 'access-control-allow-origin': '*' } }));
  await page.route(API + '/v1/live?**', async (route) => {
    const body = await response();
    if (body) await route.fulfill({ json: body, headers: { 'access-control-allow-origin': '*' } });
    else await route.abort('failed');
  });
  await page.goto(pinned ? '/?live=1&now=2026-11-04T07:20' : '/?live=1');
  await page.getByRole('button', { name: /7:20/ }).first().click();
  await page.getByRole('button', { name: lang === 'en' ? 'Lock onto this bus' : 'Seguir este autobús', exact: true }).click();
}
function packet(now = NOW, patch: Partial<LiveBusSnapshot> = {}): LiveBusSnapshot {
  return { v: 1, source: LIVE_SOURCE, feedVersion: liveDataset.meta.feedVersion, tripInstanceId: 'T1@20261104', receivedAt: now,
    vehicles: { state: 'ok', timestamp: now - 10_000 }, updates: { state: 'ok', timestamp: now - 10_000 },
    observations: [{ tripInstanceId: 'T1@20261104', vehicleId: 'bus-A', observedAt: now - 15_000, lat: 40.89, lon: -74.04 }],
    updatedAt: now - 20_000, predictions: [{ stopIndex: 1, at: NOW + 300_000, observedAt: now - 20_000, kind: 'departure' }], skippedStops: [], ...patch };
}
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('arriba.lock.v1.g2') ?? 'null'));

test('a fresh report between clock ticks binds immediately; a future receipt still fails closed', async ({ page }) => {
  let invalidFuture = false, receivedAt = 0;
  await setup(page, async () => {
    // Actual browser time advances while the response is in flight, less than a display tick.
    await page.clock.runFor(500);
    // Keep the invalid case well outside the30s tolerance even if another display tick fires.
    receivedAt = await page.evaluate(() => Date.now()) + (invalidFuture ? 60_000 : 0);
    const sample = packet(receivedAt);
    return { ...sample, vehicles: { state: 'ok', timestamp: receivedAt }, updates: { state: 'ok', timestamp: receivedAt },
      observations: [{ ...sample.observations[0]!, observedAt: receivedAt, vehicleId: invalidFuture ? 'bus-B' : 'bus-A' }],
      updatedAt: receivedAt, predictions: sample.predictions.map(p => ({ ...p, observedAt: receivedAt })) };
  });
  await expect(page.getByTestId('live-bus-status')).toContainText('NJ TRANSIT GPS · LIVE REPORT');
  const first = await saved(page);
  expect(first.session.lock.vehicleId).toBe('bus-A');
  expect(first.session.history).toHaveLength(1);
  expect(first.session.history[0].observedAt).toBe(receivedAt);
  invalidFuture = true;
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('live-bus-status')).toContainText('NJ Transit GPS data unavailable — schedule estimates only.');
  const after = await saved(page);
  expect(after.session.lock.vehicleId).toBe('bus-A');
  expect(after.session.history).toHaveLength(1);
  expect(after.session.lock.pending).toBeUndefined();
});

test('live GPS/prediction → missing feed → explicitly estimated schedule → recovered same bus', async ({ page }) => {
  let body: LiveBusSnapshot | null = packet();
  await setup(page, () => body);
  await expect(page.getByTestId('live-bus-status')).toContainText('NJ TRANSIT GPS · LIVE REPORT');
  await expect(page.getByTestId('live-bus-status')).toContainText('NJ Transit predicts departure at 7:25 AM');
  expect((await saved(page)).session.lock.vehicleId).toBe('bus-A');
  body = null;
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('live-bus-status')).toContainText('NJ Transit GPS data unavailable — schedule estimates only.');
  await expect(page.getByTestId('live-bus-status')).toContainText('NJ Transit GPS data unavailable — schedule estimates only.');
  await expect(page.getByTestId('schedule-projection').locator('progress')).toBeVisible();
  expect((await saved(page)).session.history).toHaveLength(1);
  expect((await saved(page)).session.lock.status).toBe('stale');
  body = packet(NOW + 61_000);
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('live-bus-status')).toContainText('NJ TRANSIT GPS · LIVE REPORT');
  await expect(page.getByTestId('signal-warning')).toHaveCount(0);
  const lock = await saved(page);
  expect(lock.session.lock.vehicleId).toBe('bus-A'); expect(lock.session.history).toHaveLength(2);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.favorites.v1')!))).toEqual([oldFavorite]);
});

test('ambiguous and stale snapshots never bind a bus or claim a current prediction', async ({ page }) => {
  const first = packet(), point = first.observations[0]!;
  let body = packet(NOW, { observations: [point, { ...point, vehicleId: 'bus-B' }] });
  await setup(page, () => body);
  await expect(page.getByTestId('live-bus-status')).toContainText('BUS MATCH UNCERTAIN');
  expect((await saved(page)).session.history).toHaveLength(0);
  body = packet(NOW, { vehicles: { state: 'stale', timestamp: NOW - 600_000 }, updates: { state: 'stale', timestamp: NOW - 600_000 } });
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('live-bus-status')).toContainText('NJ Transit GPS data unavailable');
  await expect(page.getByTestId('live-bus-status')).not.toContainText('NJ Transit predicts');
  expect((await saved(page)).session.lock.status).toBe('scheduled_only');
  expect((await saved(page)).session.lock.vehicleId).toBeUndefined();
});

test('a replacement requires confirmation; only a fresh official cancellation cancels the selected trip', async ({ page }) => {
  let body = packet();
  await setup(page, () => body);
  await expect(page.getByTestId('live-bus-status')).toContainText('LIVE REPORT');
  body = packet(NOW + 31_000, { observations: [{ ...packet(NOW + 31_000).observations[0]!, vehicleId: 'bus-B' }] });
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('live-bus-status')).toContainText('DIFFERENT BUS REPORTED');
  expect((await saved(page)).session.lock.vehicleId).toBe('bus-A'); expect((await saved(page)).session.lock.status).toBe('needs_confirmation');
  body = packet(NOW + 62_000, { cancelledAt: NOW + 60_000 });
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('live-bus-status')).toContainText('NJ TRANSIT REPORTS THIS TRIP CANCELLED');
  expect((await saved(page)).session.lock.status).toBe('cancelled');
});

test('Spanish live fallback is clear and fits a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  let body: LiveBusSnapshot | null = packet();
  await setup(page, () => body, 'es');
  await expect(page.getByTestId('live-bus-status')).toContainText('REPORTE EN VIVO');
  body = null;
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('live-bus-status')).toContainText('GPS de NJ Transit no disponible');
  await expect(page.getByTestId('live-bus-status').locator('p')).toHaveCount(0);
  await expect(page.getByTestId('live-bus-status')).toContainText('GPS de NJ Transit no disponible — solo estimaciones del horario.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test('live schedule is available offline without turning a saved position into live GPS', async ({ page }) => {
  await setup(page, () => packet());
  await expect(page.getByTestId('live-bus-status')).toContainText('LIVE REPORT');
  await page.route(API + '/v1/schedule', (route) => route.abort('failed'));
  await page.route(API + '/v1/live?**', (route) => route.abort('failed'));
  await page.reload();
  await expect(page.getByText(/Showing the schedule saved/)).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByTestId('live-bus-status')).toContainText('NJ Transit GPS data unavailable — schedule estimates only.');
  expect((await saved(page)).session.lock.vehicleId).toBe('bus-A');
});

test('polling stops while hidden and resumes when visible; feed warnings pass accessibility checks', async ({ page }) => {
  let calls = 0;
  await setup(page, () => { calls++; return packet(); });
  await expect(page.getByTestId('live-bus-status')).toContainText('LIVE REPORT');
  const before = calls;
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(90_000); expect(calls).toBe(before);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => calls).toBeGreaterThan(before);
  const violations = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations;
  expect(violations).toEqual([]);
});

test('known skipped stops pause automatic get-off guidance without cancelling the trip', async ({ page }) => {
  await setup(page, () => packet(NOW, { skippedStops: [2] }));
  await expect(page.getByTestId('live-bus-status')).toContainText('LIVE REPORT');
  await expect.poll(async () => (await saved(page)).session.stopChanges?.indices).toEqual([2]);
  await page.getByRole('button', { name: 'I’m waiting at this stop', exact: true }).click();
  await page.getByRole('button', { name: 'Bus arrived', exact: true }).click();
  await page.getByRole('button', { name: 'I boarded', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/automatic get-off instructions are paused/)).toBeVisible();
  expect((await saved(page)).session.lock.status).not.toBe('cancelled');
});

for (const offset of [-86_400_000, 86_400_000]) test(`live reports use the app clock when pinned time differs from wall time by ${offset} ms`, async ({ page }) => {
  await setup(page, () => packet(), 'en', NOW + offset, true);
  await expect(page.getByTestId('live-bus-status')).toContainText('LIVE REPORT');
  expect((await saved(page)).session.lock.status).toBe('tracked');
  expect((await saved(page)).session.history).toHaveLength(1);
});


test('destination arrival requires an exact official stopped-at report and retains the first time through ride end', async ({ page }) => {
  let body = packet(); await setup(page, () => body);
  await page.getByRole('button', { name: 'I’m waiting at this stop', exact: true }).click();
  await page.getByRole('button', { name: 'Bus arrived', exact: true }).click();
  await expect(page.locator('.destination-arrival')).toContainText('Arrival not confirmed');
  await page.getByRole('button', { name: 'I boarded', exact: true }).click();
  const dialog = page.getByRole('dialog'), result = dialog.locator('.destination-arrival');
  const stop = liveDataset.stops.find(s => s.id === '3')!;
  const next = NOW + 31000;
  body = packet(next, { observations: [{ tripInstanceId: 'T1@20261104', vehicleId: 'bus-A', observedAt: next - 15000, lat: stop.lat!, lon: stop.lon!, stopCall: { stopId: '3', stopIndex: 2, status: 'stopped_at' } }] });
  await page.clock.fastForward(31000);
  await expect(result).toContainText('NJ Transit observed the bus stopped');
  await expect(result).toContainText('The bus may have arrived before this GPS report');
  const arrival = await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.arrival.v1.g2')!));
  expect(arrival.at).toBe(next - 15000); expect(arrival.source).toBe('njt_stopped_at'); expect(arrival.scheduledAt).toBeDefined();
  expect(arrival).not.toHaveProperty('lat');
  body = packet(next + 31000); await page.clock.fastForward(31000);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arriba.arrival.v1.g2')!).at)).toBe(arrival.at);
  await dialog.getByRole('button', { name: 'I got off', exact: true }).click();
  await expect(page.locator('.bus-lock .destination-arrival')).toContainText('NJ Transit observed the bus stopped');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator('.last-arrival summary').click(); await expect(page.locator('.last-arrival')).toContainText('NJ Transit observed the bus stopped');
  await page.reload(); await page.locator('.last-arrival summary').click(); await expect(page.locator('.last-arrival')).toContainText('NJ Transit observed the bus stopped');
});

test('manual destination confirmation has its own source and is distinct from ending a ride', async ({ page }) => {
  await setup(page, () => null);
  await page.getByRole('button', { name: 'I’m waiting at this stop', exact: true }).click();
  await page.getByRole('button', { name: 'Bus arrived', exact: true }).click(); await page.getByRole('button', { name: 'I boarded', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog.locator('.destination-arrival')).toContainText('Arrival not confirmed');
  await dialog.getByRole('button', { name: 'I’ve reached PORT AUTHORITY BUS TERMINAL', exact: true }).click();
  await expect(dialog.locator('.destination-arrival')).toContainText('Arrival you reported');
  await expect(dialog.locator('.destination-arrival')).toContainText('not an NJ Transit observation');
  await dialog.getByRole('button', { name: 'I got off', exact: true }).click();
  await expect(page.locator('.bus-lock .destination-arrival')).toContainText('Arrival you reported');
});

for (const cancelled of [false, true]) test(`same-packet ${cancelled ? 'cancellation' : 'destination skip'} blocks stopped-at arrival confirmation`, async ({ page }) => {
  let body = packet(); await setup(page, () => body);
  const stop = liveDataset.stops.find(s => s.id === '3')!, at = NOW + 31000;
  body = packet(at, { observations: [{ tripInstanceId: 'T1@20261104', vehicleId: 'bus-A', observedAt: at - 15000, lat: stop.lat!, lon: stop.lon!, stopCall: { stopId: '3', stopIndex: 2, status: 'stopped_at' } }],
    ...(cancelled ? { cancelledAt: at - 20000 } : { skippedStops: [2] }) });
  await page.clock.fastForward(31000);
  await expect(page.locator('.destination-arrival')).toContainText('Arrival not confirmed');
  expect(await page.evaluate(() => localStorage.getItem('arriba.arrival.v1.g2'))).toBeNull();
});


test('tracker opens close to bus, keeps manual overview, and offers transit geography plus a line diagram', async ({ page }) => {
  const errors: string[] = [], outside: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { const host = new URL(r.url()).hostname; if (!['localhost', 'dale-live.test.workers.dev'].includes(host)) outside.push(host); });
  const stop = liveDataset.stops.find(s => s.id === '2')!;
  const body = packet(); body.observations[0] = { ...body.observations[0]!, lat: stop.lat!, lon: stop.lon! };
  await setup(page, () => body);
  const wrapper = page.locator('.waiting-map .map-views'), map = wrapper.locator('.route-map');
  await expect(map.locator('canvas')).toBeVisible({ timeout: 15000 }).catch(error => { throw new Error(String(error) + '\nMap diagnostics: ' + errors.join(' | ')); }); await expect(map).toHaveAttribute('data-camera', 'bus');
  await wrapper.getByRole('button', { name: 'Whole route', exact: true }).click(); await expect(map).toHaveAttribute('data-camera', 'route');
  await page.clock.fastForward(31000); await expect(map).toHaveAttribute('data-camera', 'route');
  await wrapper.getByRole('button', { name: 'Zoom to bus', exact: true }).click(); await expect(map).toHaveAttribute('data-camera', 'bus');
  await wrapper.getByRole('button', { name: 'Transit map', exact: true }).click();
  await expect(map).toHaveAttribute('data-presentation', 'transit'); await expect(map.locator('canvas')).toBeVisible({ timeout: 15000 });
  await expect(map).toContainText('OpenStreetMap');
  await page.waitForLoadState('networkidle'); await wrapper.screenshot({ path: 'test-results/transit-map-preview.png' });
  await wrapper.getByRole('button', { name: 'Line diagram', exact: true }).click();
  await expect(wrapper.locator('.transit-line-map')).toContainText('spacing is not distance');
  await expect(wrapper.locator('.line-stations [data-state="alight"]')).toContainText('Your destination');
  await wrapper.screenshot({ path: 'test-results/line-diagram-preview.png' });
  expect(outside).toEqual([]);
  expect(errors.filter(e => !/favicon|net::ERR_FAILED/.test(e))).toEqual([]);
});

test('onboard fresh GPS stays observed, highlights current not upcoming stop, and tolerates stale predictions',async({page})=>{
 const boarding=liveDataset.stops.find(s=>s.id==='2')!, destination=liveDataset.stops.find(s=>s.id==='3')!;
 let body:LiveBusSnapshot|null=packet(NOW,{updatedAt:NOW-600000,predictions:[]});
 body.observations[0]={...body.observations[0]!,lat:boarding.lat!,lon:boarding.lon!};
 await setup(page,()=>body);
 await page.getByRole('button',{name:'I’m waiting at this stop',exact:true}).click();
 await page.getByRole('button',{name:'Bus arrived',exact:true}).click();
 await page.getByRole('button',{name:'I boarded',exact:true}).click();
 const ride=page.getByRole('dialog');const strip=ride.locator('.strip');
 await expect(strip.locator('[data-current="true"]')).toHaveCount(1);
 await expect(strip.locator('[data-current="true"]')).toContainText(boarding.name);
 await expect(strip.locator('[data-state="next"][data-current="true"]')).toHaveCount(0);
 await strip.screenshot({path:'test-results/observed-gps-at-stop.png'});
 await page.clock.fastForward(20000);
 await expect(ride.locator('.progress-source')).not.toContainText('Estimated');
 await expect(ride.getByTestId('signal-warning')).toHaveCount(0);
 const time=NOW+31000;
 body=packet(time,{updatedAt:NOW-600000,predictions:[],observations:[{...body.observations[0]!,observedAt:time,lat:(boarding.lat!+destination.lat!)/2,lon:(boarding.lon!+destination.lon!)/2}]});
 await page.clock.fastForward(12000);
 await expect(strip.locator('[data-current="true"]')).toHaveCount(0);
 await expect(ride.locator('.progress-source')).toContainText("From the bus's GPS");
 await expect(ride.getByTestId('signal-warning')).toHaveCount(0);
 await strip.screenshot({path:'test-results/observed-gps-current-stop.png'});
 await ride.getByRole('button',{name:'Line diagram',exact:true}).click();
 await expect(ride.locator('.line-bus-between')).toHaveCount(1);
 await expect(ride.locator('.line-stations [data-current="true"]')).toHaveCount(0);
 body=null;
 await page.clock.fastForward(121000);
 await expect(strip.locator('[data-current="true"]')).toHaveCount(0);
 await expect(ride.getByTestId('signal-warning')).toContainText('NJ Transit GPS data unavailable — schedule estimates only.');
});



for(const stale of [false,true]) test(`missing GPS retains independently fresh departure prediction (stale=${stale})`,async({page})=>{
 const body=packet(NOW,{observations:stale?packet().observations.map(o=>({...o,observedAt:NOW-600000})):[]});
 await setup(page,()=>body);
 const notice=page.getByTestId('live-bus-status');
 await expect(notice).toContainText('NJ Transit GPS data unavailable.');
 await expect(notice).toContainText('NJ Transit predicts departure at 7:25 AM');
 await expect(notice).not.toContainText('schedule estimates only');
 await expect(notice).not.toContainText('Refreshes about every');
 await expect(notice.locator('p')).toHaveCount(1);
});
