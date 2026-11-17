import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { strings } from '../../src/ui/i18n';
import { liveDataset } from '../helpers/liveBus';

// Saving re-encodes the photo on a canvas and writes it to IndexedDB, which is CPU-heavy: under the full
// parallel suite one save took longer than the default 5 s (Nov 17, "readable in turnpike (en)").
const PHOTO_SAVE_MS = 15_000;

const API = 'https://dale-live.test.workers.dev';
const DB = 'dale-home-photo-v1';
test.use({ serviceWorkers: 'block', viewport: { width: 305, height: 780 } });
async function start(page: Page, lang: 'en' | 'es' = 'en', skin = 'garden') {
  await page.addInitScript(({ lang, skin }) => {
    if (!localStorage.getItem('arriba.settings.v1')) localStorage.setItem('arriba.settings.v1', JSON.stringify({ lang, skin }));
    if (!localStorage.getItem('arriba.favorites.v1.g2')) localStorage.setItem('arriba.favorites.v1.g2', JSON.stringify([{ id: 'synthetic', label: 'Fictional test trip', fromStopId: '2', toStopId: '3', routeIds: [] }]));
  }, { lang, skin });
  await page.route(API + '/v1/schedule', route => route.fulfill({ json: liveDataset }));
  await page.route(API + '/v1/geometry?**', route => route.abort());
  await page.route(API + '/v1/live?**', route => route.abort());
  await page.route(API + '/v1/departures?**', route => route.abort());
  await page.goto('/?live=1&now=2026-11-04T07:50');
  await page.getByRole('button', { name: strings[lang].settings, exact: true }).click();
}
async function fixture(page: Page, color = '#1a5874', type = 'image/png') {
  const data = await page.evaluate(({ color, type }) => {
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 180;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, 120, 180);
    ctx.fillStyle = '#fff'; ctx.fillRect(20, 40, 80, 25);
    return canvas.toDataURL(type).split(',')[1]!;
  }, { color, type });
  return Buffer.from(data, 'base64');
}
async function stored(page: Page) {
  return page.evaluate(async dbName => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(dbName, 1); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    const value = await new Promise<any>((resolve, reject) => { const r = db.transaction('photo').objectStore('photo').get('home'); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    db.close();
    if (!value) return null;
    if (value.blob === null) return { keys: Object.keys(value).sort(), version: value.version, removed: true };
    const bytes = new Uint8Array(await value.blob.arrayBuffer());
    const image = await createImageBitmap(value.blob); const dimensions = [image.width, image.height]; image.close();
    return { keys: Object.keys(value).sort(), version: value.version, type: value.blob.type, size: value.blob.size, dimensions, text: new TextDecoder('latin1').decode(bytes) };
  }, DB);
}
for (const lang of ['en', 'es'] as const) test(`local photo persists, replaces and removes without upload or favorite changes (${lang})`, async ({ page }) => {
  await start(page, lang); const s = strings[lang].homePhoto;
  const panel = page.locator('.home-photo-settings'), picker = panel.getByLabel(s.choose, { exact: true });
  await expect(picker).toBeEnabled();
  const before = await page.evaluate(() => localStorage.getItem('arriba.favorites.v1.g2'));
  const outbound: string[] = [];
  page.on('request', req => { const url = new URL(req.url()); if (url.protocol === 'blob:' || url.protocol === 'data:') return; if (!['localhost', 'dale-live.test.workers.dev'].includes(url.hostname) || req.method() !== 'GET') outbound.push(req.url()); });
  const input = await fixture(page);
  const chosen = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: s.choose, exact: true }).click();
  await (await chosen).setFiles({ name: 'private-location-and-person-name.png', mimeType: 'image/png', buffer: input });
  await expect(panel.getByRole('status')).toHaveText(s.saved);
  await expect(page.locator('.photo-backdrop')).toHaveAttribute('data-photo', 'personal');
  const first = await stored(page); expect(first).toMatchObject({ keys: ['blob', 'version'], type: 'image/jpeg', dimensions: [120, 180] });
  expect(first!.text).not.toContain('private-location');
  await page.reload(); await page.getByRole('button', { name: strings[lang].settings, exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(s.saved);
  await panel.getByLabel(s.replace, { exact: true }).setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: await fixture(page, '#9a3030') });
  await expect.poll(async () => (await stored(page))!.version).not.toBe(first!.version);
  await expect(panel.getByRole('status')).toHaveText(s.saved);
  await panel.getByRole('button', { name: s.remove, exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toHaveText(s.removed);
  await expect(panel.getByRole('button', { name: s.choose, exact: true })).toBeFocused();
  await expect.poll(async () => (await stored(page))?.removed).toBe(true);
  await expect(page.locator('.photo-backdrop')).not.toHaveAttribute('data-photo', 'personal');
  await page.reload(); await expect(page.locator('.photo-backdrop')).not.toHaveAttribute('data-photo', 'personal');
  expect(await page.evaluate(() => localStorage.getItem('arriba.favorites.v1.g2'))).toBe(before);
  expect(outbound).toEqual([]);
});

test('raster re-encoding strips synthetic EXIF and applies orientation before saving', async ({ page }) => {
  await start(page); const panel = page.locator('.home-photo-settings');
  const jpeg = await fixture(page, '#1a5874', 'image/jpeg');
  // Valid TIFF orientation=6 and a GPS IFD with a synthetic processing-method marker; no real data.
  const marker = Buffer.from('ASCII\0\0\0GPS-SYNTHETIC-ONLY', 'binary');
  const tiff = Buffer.alloc(56 + marker.length); tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(6, 18);
  tiff.writeUInt16LE(0x8825, 22); tiff.writeUInt16LE(4, 24); tiff.writeUInt32LE(1, 26); tiff.writeUInt32LE(38, 30);
  tiff.writeUInt16LE(1, 38); tiff.writeUInt16LE(27, 40); tiff.writeUInt16LE(7, 42);
  tiff.writeUInt32LE(marker.length, 44); tiff.writeUInt32LE(56, 48); marker.copy(tiff, 56);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const length = Buffer.alloc(2); length.writeUInt16BE(exif.length + 2);
  const tagged = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([255, 225]), length, exif, jpeg.subarray(2)]);
  await panel.locator('input').setInputFiles({ name: 'synthetic-exif.jpg', mimeType: 'image/jpeg', buffer: tagged });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  const value = await stored(page);
  expect(value!.dimensions).toEqual([180, 120]);
  expect(value!.text).not.toContain('GPS-SYNTHETIC');
  // WebKit emits fresh technical EXIF (size/color) from canvas; verify the GPS directory is absent.
  expect(await page.evaluate(async name => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(name, 1); r.onsuccess = () => resolve(r.result); });
    const blob = await new Promise<Blob>(resolve => { const r = db.transaction('photo').objectStore('photo').get('home'); r.onsuccess = () => resolve(r.result.blob); }); db.close();
    const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
    for (let p = 2; p + 4 < bytes.length;) {
      const code = bytes[p + 1]; if (code === 0xda || code === 0xd9) break;
      const length = view.getUint16(p + 2); if (length < 2 || p + 2 + length > bytes.length) throw new Error('invalid synthetic JPEG');
      if (code === 0xe1 && String.fromCharCode(...bytes.slice(p + 4, p + 8)) === 'Exif') {
        const base = p + 10, little = bytes[base] === 73, ifd = base + view.getUint32(base + 4, little);
        const count = view.getUint16(ifd, little);
        for (let i = 0; i < count; i++) if (view.getUint16(ifd + 2 + 12 * i, little) === 0x8825) return true;
      }
      p += 2 + length;
    }
    return false;
  }, DB)).toBe(false);
});

for (const lang of ['en', 'es'] as const) test(`empty, invalid and oversized input retain the previous photo (${lang})`, async ({ page }) => {
  await start(page, lang); const panel = page.locator('.home-photo-settings'), input = panel.locator('input');
  await input.setInputFiles({ name: 'good.png', mimeType: 'image/png', buffer: await fixture(page) });
  await expect(panel.getByRole('status')).toHaveText(strings[lang].homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  const before = await stored(page);
  for (const [mimeType, buffer, message] of [
    ['image/png', Buffer.alloc(0), 'decode'],
    ['image/svg+xml', Buffer.from('<svg onload="alert(1)"/>'), 'format'],
    ['image/png', Buffer.from('not a raster'), 'format'],
    ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), 'decode'],
    ['image/png', Buffer.alloc(12 * 1024 * 1024 + 1), 'large'],
  ] as const) {
    await input.setInputFiles({ name: 'synthetic', mimeType, buffer });
    await expect(panel.getByRole('status')).toHaveText(strings[lang].homePhoto[message]);
    expect((await stored(page))!.version).toBe(before!.version);
  }
});

test('unavailable storage does not block app use or claim success', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { get() { throw new Error('synthetic denied'); } }); });
  await start(page); const panel = page.locator('.home-photo-settings');
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.storage);
  await expect(panel.locator('input')).toBeDisabled();
  await panel.getByRole('button', { name: strings.en.retry, exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.storage);
  await page.getByRole('button', { name: strings.en.back, exact: true }).click();
  await expect(page.locator('.dep').first()).toBeVisible();
});

for (const lang of ['en', 'es'] as const) for (const skin of ['garden', 'turnpike', 'parkway', 'nyc', 'clean']) test(`photo settings remain readable in ${skin} (${lang})`, async ({ page }) => {
  await start(page, lang, skin); const panel = page.locator('.home-photo-settings');
  await panel.locator('input').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: await fixture(page) });
  await expect(panel.getByRole('status')).toHaveText(strings[lang].homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; document.body.style.fontSize = '32px'; });
  await expect(page.locator('.photo-backdrop')).toHaveAttribute('data-photo', 'personal');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include('.home-photo-settings').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  if (skin === 'garden') await panel.screenshot({ path: `test-results/home-photo-settings-${lang}.png` });
});

test('failed replacement and removal transactions preserve the committed photo', async ({ page }) => {
  await start(page); const panel = page.locator('.home-photo-settings'), input = panel.locator('input');
  await input.setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: await fixture(page) });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  const before = await stored(page);
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('synthetic quota', 'QuotaExceededError'); };
  });
  await input.setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: await fixture(page, '#bbaa00') });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.storage);
  expect((await stored(page))!.version).toBe(before!.version);
  await panel.getByRole('button', { name: strings.en.homePhoto.remove, exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.storage);
  expect((await stored(page))!.version).toBe(before!.version);
  await expect(panel.getByRole('img')).toBeVisible();
});

test('a cross-tab choice during decoding cannot be overwritten by the older tab', async ({ page, context }) => {
  await start(page); const panel = page.locator('.home-photo-settings'), input = panel.locator('input');
  await input.setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: await fixture(page) });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  const other = await context.newPage(); await start(other);
  await expect(other.locator('.home-photo-settings').getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      (window as any).finishSyntheticEncode = () => original.call(this, callback, type, quality);
    };
  });
  await input.setInputFiles({ name: 'slow.png', mimeType: 'image/png', buffer: await fixture(page, '#000000') });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.busy);
  await expect.poll(() => page.evaluate(() => typeof (window as any).finishSyntheticEncode)).toBe('function');
  await other.locator('.home-photo-settings input').setInputFiles({ name: 'latest.png', mimeType: 'image/png', buffer: await fixture(other, '#eeeeee') });
  await expect(other.locator('.home-photo-settings').getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  const latest = await stored(other);
  await page.evaluate(() => (window as any).finishSyntheticEncode());
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.conflict);
  expect((await stored(page))!.version).toBe(latest!.version);
  await expect(panel.getByRole('img')).toBeVisible();
  await other.close();
});

test('large raster is resized and every personal object URL is released on removal', async ({ page }) => {
  await page.addInitScript(() => {
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    (window as any).syntheticUrls = new Set<string>();
    URL.createObjectURL = object => { const url = create(object); (window as any).syntheticUrls.add(url); return url; };
    URL.revokeObjectURL = url => { (window as any).syntheticUrls.delete(url); revoke(url); };
  });
  await start(page); const panel = page.locator('.home-photo-settings');
  const bytes = Buffer.from(await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 3000; c.height = 1500;
    c.getContext('2d')!.fillRect(0, 0, 3000, 1500); return c.toDataURL('image/png').split(',')[1]!;
  }), 'base64');
  await panel.locator('input').setInputFiles({ name: 'large-synthetic.png', mimeType: 'image/png', buffer: bytes });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  expect((await stored(page))!.dimensions).toEqual([2048, 1024]);
  await panel.getByRole('button', { name: strings.en.homePhoto.remove, exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.removed);
  await expect.poll(() => page.evaluate(() => (window as any).syntheticUrls.size)).toBe(0);
});

test('request success followed by transaction abort never claims a saved replacement', async ({ page }) => {
  await start(page); const panel = page.locator('.home-photo-settings');
  await panel.locator('input').setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: await fixture(page) });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  const before = await stored(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      const tx = this.transaction; const request = put.call(this, value, key!);
      request.addEventListener('success', () => tx.abort()); return request;
    };
  });
  await panel.locator('input').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: await fixture(page, '#aa00cc') });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.storage);
  expect((await stored(page))!.version).toBe(before!.version);
});

test('unsupported decoder and canvas refusal keep the original saved choice', async ({ page }) => {
  await start(page); const panel = page.locator('.home-photo-settings');
  await panel.locator('input').setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: await fixture(page) });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  const before = await stored(page), second = await fixture(page, '#22cc33');
  await page.evaluate(() => {
    (window as any).originalBitmap = window.createImageBitmap;
    Object.defineProperty(window, 'createImageBitmap', { value: undefined, configurable: true });
  });
  await panel.locator('input').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: second });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.decode);
  await page.evaluate(() => { Object.defineProperty(window, 'createImageBitmap', { value: (window as any).originalBitmap, configurable: true }); HTMLCanvasElement.prototype.toBlob = callback => callback(null); });
  await panel.locator('input').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: second });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.decode);
  expect((await stored(page))!.version).toBe(before!.version);
});

test('cross-tab delete refuses to remove a newer photo when change notifications are unavailable', async ({ page, context }) => {
  await context.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { value: undefined }); });
  await start(page); const panel = page.locator('.home-photo-settings');
  await panel.locator('input').setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: await fixture(page) });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  const other = await context.newPage(); await start(other);
  await other.locator('.home-photo-settings input').setInputFiles({ name: 'newer.png', mimeType: 'image/png', buffer: await fixture(other, '#aa8877') });
  await expect(other.locator('.home-photo-settings').getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  const latest = await stored(other);
  // Trigger the ordinary native handler without a foreground refresh repairing the intentionally stale tab first.
  await panel.getByRole('button', { name: strings.en.homePhoto.remove, exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.conflict);
  expect((await stored(page))!.version).toBe(latest!.version);
  await other.close();
});

test('malformed stored records fail closed without deleting them or blocking trips', async ({ page }) => {
  await start(page); const panel = page.locator('.home-photo-settings');
  await panel.locator('input').setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: await fixture(page) });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  await page.evaluate(async name => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(name, 1); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('photo', 'readwrite'); tx.objectStore('photo').put({ version: 'invalid', filename: 'synthetic-only' }, 'home');
      tx.oncomplete = () => resolve(); tx.onabort = reject;
    }); db.close();
  }, DB);
  await page.reload(); await page.getByRole('button', { name: strings.en.settings, exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.storage);
  await expect(panel.locator('input')).toBeDisabled();
  expect(await page.evaluate(async name => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(name, 1); r.onsuccess = () => resolve(r.result); });
    const value = await new Promise(resolve => { const r = db.transaction('photo').objectStore('photo').get('home'); r.onsuccess = () => resolve(r.result); });
    db.close(); return value;
  }, DB)).toEqual({ version: 'invalid', filename: 'synthetic-only' });
  await page.getByRole('button', { name: strings.en.back, exact: true }).click();
  await expect(page.locator('.dep').first()).toBeVisible();
});

test('a newer removal supersedes an older pending first photo selection', async ({ page, context }) => {
  await start(page); const panel = page.locator('.home-photo-settings');
  const candidate = await fixture(page);
  await page.evaluate(() => {
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) { (window as any).releaseFirstPhoto = () => encode.call(this, callback, type, quality); };
  });
  await panel.locator('input').setInputFiles({ name: 'older-first.png', mimeType: 'image/png', buffer: candidate });
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseFirstPhoto)).toBe('function');
  const other = await context.newPage(); await start(other);
  const otherPanel = other.locator('.home-photo-settings');
  await otherPanel.locator('input').setInputFiles({ name: 'newer.png', mimeType: 'image/png', buffer: await fixture(other, '#ff3300') });
  await expect(otherPanel.getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  await otherPanel.getByRole('button', { name: strings.en.homePhoto.remove, exact: true }).click();
  await expect(otherPanel.getByRole('status')).toHaveText(strings.en.homePhoto.removed);
  await page.evaluate(() => (window as any).releaseFirstPhoto());
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.conflict);
  await expect(panel.getByRole('img')).toHaveCount(0);
  await expect(page.locator('.photo-backdrop')).not.toHaveAttribute('data-photo', 'personal');
  await other.close();
});

test('a cross-tab removal during failed decoding clears the old preview and keeps the failure message', async ({ page, context }) => {
  await start(page); const panel = page.locator('.home-photo-settings');
  await panel.locator('input').setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: await fixture(page) });
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  const other = await context.newPage(); await start(other);
  await expect(other.locator('.home-photo-settings').getByRole('status')).toHaveText(strings.en.homePhoto.saved, { timeout: PHOTO_SAVE_MS });
  await page.evaluate(() => { window.createImageBitmap = () => new Promise((_resolve, reject) => { (window as any).rejectPhotoDecode = () => reject(new DOMException('synthetic bad raster', 'InvalidStateError')); }); });
  await panel.locator('input').setInputFiles({ name: 'corrupt.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]) });
  await expect.poll(() => page.evaluate(() => typeof (window as any).rejectPhotoDecode)).toBe('function');
  await other.locator('.home-photo-settings').getByRole('button', { name: strings.en.homePhoto.remove, exact: true }).click();
  await expect(other.locator('.home-photo-settings').getByRole('status')).toHaveText(strings.en.homePhoto.removed);
  await page.evaluate(() => (window as any).rejectPhotoDecode());
  await expect(panel.getByRole('status')).toHaveText(strings.en.homePhoto.decode);
  await expect(panel.getByRole('img')).toHaveCount(0);
  await expect(page.locator('.photo-backdrop')).not.toHaveAttribute('data-photo', 'personal');
  await other.close();
});
