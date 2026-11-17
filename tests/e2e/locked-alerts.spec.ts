import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { liveDataset, NOW } from '../helpers/liveBus';
import { LIVE_SOURCE, type LiveBusSnapshot } from '../../src/domain/liveBus';
import { strings } from '../../src/ui/i18n';

// Locked-phone stop alerts (#176 step C, docs/LOCKED_STOP_ALERTS.md). Dale's Worker is mocked with
// page.route; the browser's push service and notifications are stand-ins that record what Dale asked for.
test.use({ serviceWorkers: 'block' });

const API = 'https://dale-live.test.workers.dev';
const CODE = 'AB12CD34EF56GH78';
const RIDE = 'AbCdEfGhIjKlMnOpQrStUv';
// An invented, well-formed uncompressed P-256 point (0x04 then 64 bytes); never a real key.
const PUBLIC_KEY = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i))).toString('base64url');
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, DELETE', 'access-control-allow-headers': 'content-type' };

type Lang = 'en' | 'es';
interface Server {
  config: () => unknown;
  register: (body: Record<string, unknown>) => { status: number; json: unknown };
  remove: (route: Route) => Promise<void>;
  /** Answers an activation; by default 200 active. */
  activate: () => Promise<number>;
  posts: Record<string, unknown>[]; activations: number; deletes: string[];
  /** At each activation call: the ride id in the service worker's record and the ride saved on the phone. */
  atActivate: { record: string | null; saved: string | null }[];
}

async function setup(page: Page, opts: { lang?: Lang; enabled?: boolean; granted?: boolean; failRecord?: boolean } = {}): Promise<Server> {
  const lang = opts.lang ?? 'en';
  const server: Server = {
    config: () => ({ v: 1, available: true, publicKey: PUBLIC_KEY }),
    register: () => ({ status: 201, json: { v: 1, id: RIDE, expiresAt: NOW + 3_600_000 } }),
    remove: (route) => route.fulfill({ status: 204, headers: cors }),
    activate: async () => 200,
    posts: [], activations: 0, deletes: [], atActivate: [],
  };
  await page.clock.install({ time: NOW });
  await page.addInitScript(({ lang, enabled, granted, failRecord, code }) => {
    // Seeded once per test, so a reload keeps what Dale saved.
    if (!sessionStorage.getItem('test-seeded')) {
      sessionStorage.setItem('test-seeded', '1');
      localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'live-test', label: 'My live bus', fromStopId: '2', toStopId: '3', routeIds: ['10'] }]));
      localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin: 'clean', theme: 'light', count: 3 }));
      if (enabled) localStorage.setItem('arriba.rideAlerts.v1', JSON.stringify({ enabled: true, code, pending: [] }));
    }
    const w = window as unknown as Record<string, unknown>;
    const log: string[] = []; w.__log = log;
    // Whether a ride was ever saved on this phone (it must never be saved before its service-worker record).
    w.__rideSaved = false;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'arriba.rideAlerts.v1' && JSON.parse(value)?.ride) w.__rideSaved = true;
      return setItem.call(this, key, value);
    };
    class FakeNotification {
      static permission: NotificationPermission = granted ? 'granted' : 'default';
      static requestPermission() { log.push('permission'); FakeNotification.permission = 'granted'; return Promise.resolve(FakeNotification.permission); }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: FakeNotification });
    let n = 0;
    const subscription = (endpoint: string) => ({ endpoint, unsubscribe: async () => { log.push(`unsubscribe ${endpoint}`); current = null; return true; } });
    // A subscription left from an earlier ride: Dale must drop it before subscribing again.
    let current: ReturnType<typeof subscription> | null = subscription('https://fcm.googleapis.com/fcm/send/earlier');
    const reg = {
      pushManager: {
        getSubscription: async () => current,
        subscribe: async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
          log.push(`subscribe ${o.userVisibleOnly} ${new Uint8Array(o.applicationServerKey).length}`);
          current = subscription(`https://fcm.googleapis.com/fcm/send/ride-${++n}`);
          return current;
        },
      },
      showNotification: async () => {},
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      ready: Promise.resolve(reg), register: async () => reg, getRegistration: async () => reg, addEventListener: () => {},
    } });
    if (failRecord) IDBObjectStore.prototype.put = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
  }, { lang, enabled: !!opts.enabled, granted: !!opts.granted, failRecord: !!opts.failRecord, code: CODE });
  await page.route(API + '/v1/departures?**', (route) => route.abort('failed'));
  await page.route(API + '/v1/geometry?**', (route) => route.abort('failed'));
  await page.route(API + '/v1/schedule', (route) => route.fulfill({ json: liveDataset, headers: cors }));
  await page.route(API + '/v1/live?**', (route) => route.fulfill({ json: packet(), headers: cors }));
  await page.route(API + '/v1/ride-alerts**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-max-age': '600' } });
    if (path === '/v1/ride-alerts/config') return route.fulfill({ json: server.config(), headers: cors });
    if (path === '/v1/ride-alerts' && req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      server.posts.push(body);
      const answer = server.register(body);
      return route.fulfill({ status: answer.status, json: answer.json, headers: cors });
    }
    if (path.endsWith('/activate')) {
      server.atActivate.push({ record: ((await swRecord(page)) as { rideId?: string } | null)?.rideId ?? null, saved: (await saved(page))?.ride?.id ?? null });
      const status = await server.activate();
      if (status !== 200) return route.fulfill({ status, json: { v: 1 }, headers: cors });
      server.activations++; return route.fulfill({ json: { v: 1, state: 'active' }, headers: cors });
    }
    if (req.method() === 'DELETE') { server.deletes.push(`${path}${new URL(req.url()).search}`); return server.remove(route); }
    return route.fulfill({ status: 404, json: { v: 1 }, headers: cors });
  });
  return server;
}

function packet(): LiveBusSnapshot {
  return { v: 1, source: LIVE_SOURCE, feedVersion: liveDataset.meta.feedVersion, tripInstanceId: 'T1@20261104', receivedAt: NOW,
    vehicles: { state: 'ok', timestamp: NOW - 10_000 }, updates: { state: 'ok', timestamp: NOW - 10_000 },
    observations: [{ tripInstanceId: 'T1@20261104', vehicleId: 'bus-A', observedAt: NOW - 15_000, lat: 40.89, lon: -74.04 }],
    updatedAt: NOW - 20_000, predictions: [], skippedStops: [] };
}

async function openSettings(page: Page, lang: Lang) {
  await page.goto('/?live=1');
  await page.getByRole('button', { name: strings[lang].settings, exact: true }).click();
}

async function board(page: Page, lang: Lang) {
  const t = strings[lang];
  await page.goto('/?live=1');
  await page.getByRole('button', { name: /7:20/ }).first().click();
  await page.getByRole('button', { name: t.lockBus, exact: true }).click();
  await expect(page.getByTestId('live-bus-status')).toContainText(/GPS/);
  await page.getByRole('button', { name: t.busLock.begin, exact: true }).click();
  await page.getByRole('button', { name: t.busLock.arrived, exact: true }).click();
  await page.getByRole('button', { name: t.busLock.boarded, exact: true }).click();
  return page.getByRole('dialog');
}

const log = (page: Page) => page.evaluate(() => (window as unknown as { __log: string[] }).__log);
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('arriba.rideAlerts.v1') ?? 'null'));
const swRecord = (page: Page) => page.evaluate(() => new Promise((resolve) => {
  const open = indexedDB.open('dale-ride-alerts', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('ride');
  open.onsuccess = () => {
    const get = open.result.transaction('ride', 'readonly').objectStore('ride').get('current');
    get.onsuccess = () => { open.result.close(); resolve(get.result ?? null); };
  };
}));

for (const lang of ['en', 'es'] as const) test(`turning it on explains the server record, asks for the household code, then for notifications (${lang})`, async ({ page }) => {
  const s = strings[lang].lockedAlerts;
  await setup(page, { lang });
  await openSettings(page, lang);
  const toggle = page.getByRole('checkbox', { name: s.title });
  await expect(toggle).not.toBeChecked(); // off by default
  await toggle.check();
  const form = page.locator('.locked-consent');
  for (const line of [s.consent, s.noLocation, ...s.limits]) await expect(form.getByText(line, { exact: true })).toBeVisible();
  const code = form.getByRole('textbox', { name: s.codeLabel });
  await expect(code).toBeFocused();
  expect(await log(page)).toEqual([]); // nothing is asked before the rider agrees
  await form.getByRole('button', { name: s.turnOn }).click();
  await expect(form.getByRole('alert')).toHaveText(s.codeInvalid);
  await code.fill(' ab12-cd34 ef56 gh78 ');
  await code.press('Enter');
  await expect(toggle).toBeChecked();
  await expect(form).toHaveCount(0);
  await expect(page.locator('.locked-status [role=status]')).toHaveText(s.ready(strings[lang].busLock.boarded));
  expect(await log(page)).toEqual(['permission']);
  expect(await saved(page)).toEqual({ enabled: true, code: CODE, pending: [] });
  // The honest limits stay next to the setting.
  await page.getByText(s.limitsTitle, { exact: true }).click();
  for (const line of s.limits) await expect(page.getByText(line, { exact: true })).toBeVisible();
});

for (const lang of ['en', 'es'] as const) test(`an unavailable server or browser says so plainly and stays off (${lang})`, async ({ page }) => {
  const s = strings[lang].lockedAlerts;
  const server = await setup(page, { lang });
  server.config = () => ({ v: 1, available: false });
  await openSettings(page, lang);
  const toggle = page.getByRole('checkbox', { name: s.title });
  await toggle.check();
  await page.getByRole('textbox', { name: s.codeLabel }).fill(CODE);
  await page.getByRole('button', { name: s.turnOn }).click();
  await expect(page.locator('.locked-status [role=status]')).toHaveText(s.unavailable);
  await expect(toggle).not.toBeChecked();
  expect((await saved(page))?.enabled ?? false).toBe(false);
  // No Push API at all: the same plain answer for the browser.
  await page.evaluate(() => { delete (window as unknown as { PushManager?: unknown }).PushManager; });
  await toggle.check();
  await page.getByRole('textbox', { name: s.codeLabel }).fill(CODE);
  await page.getByRole('button', { name: s.turnOn }).click();
  await expect(page.locator('.locked-status [role=status]')).toHaveText(s.unsupported);
  await expect(toggle).not.toBeChecked();
});

for (const lang of ['en', 'es'] as const) test(`boarding registers a fresh ride, activates it, and "I got off" ends it in order (${lang})`, async ({ page }) => {
  const s = strings[lang].lockedAlerts;
  const server = await setup(page, { lang, enabled: true, granted: true });
  const ride = await board(page, lang);
  await expect(ride.locator('.locked-status [role=status]')).toHaveText(s.on);
  expect(server.posts).toEqual([{ v: 1, code: CODE, endpoint: 'https://fcm.googleapis.com/fcm/send/ride-1', trip: 'T1', date: '20261104', vehicle: 'bus-A', board: 1, alight: 2, lang }]);
  expect(server.activations).toBe(1);
  // Created, then the service worker's record, then saved on the phone, then activated.
  expect(server.atActivate).toEqual([{ record: RIDE, saved: RIDE }]);
  expect(await log(page)).toEqual(['unsubscribe https://fcm.googleapis.com/fcm/send/earlier', 'subscribe true 65']);
  expect(await swRecord(page)).toEqual({ rideId: RIDE, endpoint: 'https://fcm.googleapis.com/fcm/send/ride-1', apiBase: API, lang, highestShown: 0, noticeShown: false,
    text: { cantCheck: { title: s.noteTitle, body: s.cantCheck }, ended: { title: s.endedTitle, body: s.ended } } });
  await expect(ride.getByText(s.foregroundOn)).toBeVisible();

  let atDelete: unknown[] = [];
  server.remove = async (route) => { atDelete = [await log(page), await swRecord(page)]; await route.fulfill({ status: 204, headers: cors }); };
  await ride.getByRole('button', { name: strings[lang].ride.gotOff }).click();
  await expect.poll(() => server.deletes).toEqual([`/v1/ride-alerts/${RIDE}?reason=got_off`]);
  // Unsubscribed first, then the record deleted, then the server told.
  expect(atDelete).toEqual([['unsubscribe https://fcm.googleapis.com/fcm/send/earlier', 'subscribe true 65', 'unsubscribe https://fcm.googleapis.com/fcm/send/ride-1'], null]);
  await expect.poll(() => saved(page)).toEqual({ enabled: true, code: CODE, pending: [] });
});

test('a wrong household code asks for it again, and the ride starts with the new one', async ({ page }) => {
  const s = strings.en.lockedAlerts;
  const server = await setup(page, { enabled: true, granted: true });
  server.register = (body) => body.code === CODE ? { status: 401, json: { v: 1, error: 'code' } } : { status: 201, json: { v: 1, id: RIDE, expiresAt: NOW + 3_600_000 } };
  const ride = await board(page, 'en');
  await expect(ride.getByRole('alert').filter({ hasText: s.wrongCode })).toBeVisible();
  expect(await saved(page)).toEqual({ enabled: true, pending: [] }); // the refused code is not kept
  expect((await log(page)).at(-1)).toBe('unsubscribe https://fcm.googleapis.com/fcm/send/ride-1');
  await ride.getByRole('textbox', { name: s.codeLabel }).fill('zz99-zz99-zz99-zz99');
  await ride.getByRole('button', { name: s.saveCode }).click();
  await expect(ride.locator('.locked-status [role=status]')).toHaveText(s.on);
  expect(server.posts.map((p) => p.code)).toEqual([CODE, 'ZZ99ZZ99ZZ99ZZ99']);
  // The ride screen itself was never blocked.
  await expect(ride.getByRole('button', { name: strings.en.ride.gotOff })).toBeEnabled();
});

test('a full server says so, keeps alerts while open, and can be tried again', async ({ page }) => {
  const s = strings.en.lockedAlerts;
  const server = await setup(page, { enabled: true, granted: true });
  server.register = () => ({ status: 429, json: { v: 1, error: 'full' } });
  const ride = await board(page, 'en');
  await expect(ride.locator('.locked-status [role=status]')).toHaveText(s.full);
  await expect(ride.getByRole('checkbox', { name: strings.en.ride.notify })).toBeVisible();
  server.register = () => ({ status: 201, json: { v: 1, id: RIDE, expiresAt: NOW } });
  await ride.getByRole('button', { name: s.tryAgain }).click();
  await expect(ride.locator('.locked-status [role=status]')).toHaveText(s.on);
  expect(server.posts).toHaveLength(2);
});

test('a ride record this phone cannot save deletes the ride at once and keeps alerts while open', async ({ page }) => {
  const s = strings.en.lockedAlerts;
  const server = await setup(page, { enabled: true, granted: true, failRecord: true });
  const ride = await board(page, 'en');
  await expect(ride.locator('.locked-status [role=status]')).toHaveText(s.storage);
  await expect.poll(() => server.deletes).toEqual([`/v1/ride-alerts/${RIDE}?reason=unlocked`]);
  expect(server.activations).toBe(0);
  // The ride was never saved on the phone, so nothing could activate it later.
  expect(await page.evaluate(() => (window as unknown as { __rideSaved: boolean }).__rideSaved)).toBe(false);
  expect((await saved(page)).ride).toBeUndefined();
});

test('a saved ride whose service-worker record is missing is never activated: it is deleted on the server', async ({ page }) => {
  const s = strings.en.lockedAlerts;
  const server = await setup(page, { enabled: true, granted: true });
  // The first try fails, and meanwhile the record is lost (as after a start that was cut short).
  let first = true;
  server.activate = async () => {
    if (!first) return 200;
    first = false;
    await page.evaluate(() => new Promise((resolve) => { const open = indexedDB.open('dale-ride-alerts', 1); open.onsuccess = () => {
      const tx = open.result.transaction('ride', 'readwrite'); tx.objectStore('ride').delete('current'); tx.oncomplete = () => { open.result.close(); resolve(null); };
    }; }));
    return 503;
  };
  const ride = await board(page, 'en');
  await expect.poll(() => server.deletes).toEqual([`/v1/ride-alerts/${RIDE}?reason=unlocked`]);
  await expect(ride.locator('.locked-status [role=status]')).toHaveText(s.storage);
  expect(server.activations).toBe(0);
  expect(server.atActivate).toEqual([{ record: RIDE, saved: RIDE }]);
  expect((await saved(page)).ride).toBeUndefined();
});

test('changing the language mid-ride ends the ride and registers a new one in the new language', async ({ page }) => {
  const server = await setup(page, { enabled: true, granted: true });
  const second = 'ZyXwVuTsRqPoNmLkJiHgFe';
  server.register = () => ({ status: 201, json: { v: 1, id: server.posts.length > 1 ? second : RIDE, expiresAt: NOW + 3_600_000 } });
  const ride = await board(page, 'en');
  await expect(ride.locator('.locked-status [role=status]')).toHaveText(strings.en.lockedAlerts.on);
  // Dale opens again with the lock offered back; the rider switches to Spanish, then resumes.
  await page.reload();
  const offer = page.locator('.lock-return[role="note"]');
  await expect(offer).toBeVisible();
  await page.getByRole('button', { name: strings.en.settings, exact: true }).click();
  await page.getByRole('button', { name: 'Español', exact: true }).first().click();
  await page.keyboard.press('Escape');
  await offer.getByRole('button', { name: strings.es.busLock.resumeYes, exact: true }).click();
  await expect.poll(() => server.posts.map((p) => p.lang)).toEqual(['en', 'es']);
  await expect.poll(() => server.activations).toBe(2);
  expect(server.deletes).toEqual([`/v1/ride-alerts/${RIDE}?reason=unlocked`]);
  expect(await swRecord(page)).toMatchObject({ rideId: second, lang: 'es', text: { ended: { title: strings.es.lockedAlerts.endedTitle, body: strings.es.lockedAlerts.ended } } });
});

for (const lang of ['en', 'es'] as const) test(`turning it off offline keeps the delete and sends it when the network returns (${lang})`, async ({ page }) => {
  const s = strings[lang].lockedAlerts;
  const server = await setup(page, { lang, enabled: true, granted: true });
  const ride = await board(page, lang);
  await expect(ride.locator('.locked-status [role=status]')).toHaveText(s.on);
  let offline = true;
  server.remove = (route) => offline ? route.abort('internetdisconnected') : route.fulfill({ status: 204, headers: cors });
  await ride.getByRole('checkbox', { name: s.title }).uncheck();
  await expect(ride.getByRole('checkbox', { name: s.title })).not.toBeChecked();
  await expect(ride.locator('.locked-status [role=status]')).toHaveText(s.removing);
  expect(await swRecord(page)).toBeNull();
  expect((await log(page)).at(-1)).toBe('unsubscribe https://fcm.googleapis.com/fcm/send/ride-1');
  expect((await saved(page)).pending).toEqual([expect.objectContaining({ id: RIDE, reason: 'unlocked' })]);
  offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(ride.locator('.locked-status [role=status]')).toHaveText('');
  expect(server.deletes).toEqual([`/v1/ride-alerts/${RIDE}?reason=unlocked`, `/v1/ride-alerts/${RIDE}?reason=unlocked`]);
  expect((await saved(page)).pending).toEqual([]);
});

test('a delete still saved when Dale opens again is retried then', async ({ page }) => {
  const server = await setup(page);
  await page.addInitScript((ride) => localStorage.setItem('arriba.rideAlerts.v1', JSON.stringify({ enabled: false,
    pending: [{ id: ride, apiBase: 'https://dale-live.test.workers.dev', reason: 'got_off', since: Date.now() - 60_000 }] })), RIDE);
  await openSettings(page, 'en');
  await expect.poll(() => server.deletes).toEqual([`/v1/ride-alerts/${RIDE}?reason=got_off`]);
  await expect.poll(async () => (await saved(page)).pending).toEqual([]);
});

for (const lang of ['en', 'es'] as const) test(`the consent fits a narrow phone at 200% text, works by keyboard and passes accessibility (${lang})`, async ({ page }) => {
  const s = strings[lang].lockedAlerts;
  await setup(page, { lang });
  await openSettings(page, lang);
  await page.getByRole('checkbox', { name: s.title }).check();
  for (const width of [320, 412]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    for (const target of [page.getByRole('textbox', { name: s.codeLabel }), page.getByRole('button', { name: s.turnOn }), page.getByRole('button', { name: s.cancel })]) {
      const box = (await target.boundingBox())!;
      expect(box.x + box.width, `${lang} ${width}px`).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  const { violations } = await new AxeBuilder({ page }).include('.locked-alerts').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  // Keyboard: type the code, Tab to the button, Enter.
  await page.getByRole('textbox', { name: s.codeLabel }).fill(CODE);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: s.turnOn })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('checkbox', { name: s.title })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: s.title })).toBeFocused();
});
