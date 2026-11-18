// Runs the locked-phone stop alert handlers in public/sw.js (#176 step C, docs/LOCKED_STOP_ALERTS.md step 7)
// against a stand-in ride record, push subscription, Dale server and notification tray.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://jwchr.github.io';
const API = 'https://dale-live.test.workers.dev';
const RIDE = 'AAAAAAAAAAAAAAAAAAAAAA';
const NEW_RIDE = 'BBBBBBBBBBBBBBBBBBBBBB';
const source = readFileSync(join(__dirname, '../../public/sw.js'), 'utf8');

interface Shown { title: string; options: { body: string; tag: string; renotify: boolean; silent: boolean; lang?: string } }
interface Io {
  read: () => Promise<unknown>; update: (change: (r: unknown) => unknown) => Promise<void>; subscription: () => Promise<{ endpoint: string } | null>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>; show: (title: string, options: Shown['options']) => Promise<void>; now: () => number;
}
type Handler = (e: { waitUntil: (p: Promise<unknown>) => void; notification?: { close: () => void } }) => void;

let handlers: Record<string, Handler>;
let io: Io;
let record: Record<string, unknown> | undefined;
let endpoint: string;
let clock: number;
let log: string[];
let shown: Shown[];
let server: (url: string, init?: RequestInit) => Promise<Response>;
/** Runs inside the stand-in transaction, before its read: what the page changed just before the worker's update. */
let beforeUpdate: (() => void) | undefined;
/** Runs once the stand-in transaction has written. */
let afterWrite: (() => void) | undefined;
let failWrite: boolean;
let clients: { matchAll: () => Promise<{ url: string; focus: () => Promise<void> }[]>; openWindow: (u: string) => Promise<void> };

const T0 = Date.parse('2026-11-17T12:00:00Z');
const text = (lang: 'en' | 'es') => lang === 'en'
  ? { cantCheck: { title: 'Dale: your stop', body: 'Dale can’t check your bus right now. Open Dale.' }, ended: { title: 'Dale', body: 'Your Dale stop alert has ended.' } }
  : { cantCheck: { title: 'Dale: tu parada', body: 'Dale no puede revisar tu autobús ahora. Abre Dale.' }, ended: { title: 'Dale', body: 'Tu alerta de parada de Dale terminó.' } };
const makeRecord = (patch: Record<string, unknown> = {}) => ({ rideId: RIDE, endpoint: 'https://fcm.googleapis.com/fcm/send/new', apiBase: API, lang: 'en', highestShown: 0, noticeShown: false, text: text('en'), ...patch });
const stage = (stageName: string, rank: number, body: string, observedAt = clock - 10_000) =>
  ({ v: 1, kind: 'stage', stage: stageName, rank, stopsAway: 0, observedAt, receivedAt: observedAt + 2_000, title: 'Dale: your stop', body });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  handlers = {}; log = []; shown = []; clock = T0; beforeUpdate = undefined; afterWrite = undefined; failWrite = false;
  record = makeRecord();
  endpoint = 'https://fcm.googleapis.com/fcm/send/new';
  server = async () => json(stage('three', 1, '3 stops to Port Authority'));
  clients = { matchAll: async () => [], openWindow: async (u) => { log.push(`open ${u}`); } };
  const self = {
    location: { origin: ORIGIN, href: `${ORIGIN}/dale/sw.js` },
    skipWaiting: () => {}, clients,
    addEventListener: (type: string, fn: Handler) => { handlers[type] = fn; },
  };
  const exported = new Function('self', 'caches', 'fetch', `${source}\nreturn { rideIo };`)(self, {}, () => Promise.reject(new Error('unused'))) as { rideIo: Io };
  io = exported.rideIo;
  io.read = async () => { log.push('read'); return record ? structuredClone(record) : undefined; };
  // One readwrite transaction: read, decide and write with nothing in between, as in IndexedDB.
  io.update = async (change) => {
    beforeUpdate?.();
    const next = change(record ? structuredClone(record) : undefined);
    if (!next) return;
    if (failWrite) throw new DOMException('Storage full', 'QuotaExceededError');
    log.push('write'); record = structuredClone(next) as Record<string, unknown>;
    afterWrite?.();
  };
  io.subscription = async () => (endpoint ? { endpoint } : null);
  io.fetch = (url, init) => { log.push(`${init?.method ?? 'GET'} ${url.replace(API, '')}${init?.body ? ` ${String(init.body)}` : ''}`); return server(url, init); };
  io.show = async (title, options) => { log.push('show'); shown.push({ title, options }); };
  io.now = () => clock;
});

/** Dispatches one push and returns the promise the worker stays alive for. */
function push(): Promise<unknown> {
  let kept: Promise<unknown> = Promise.resolve();
  handlers.push!({ waitUntil: (p) => { kept = p; } });
  return kept;
}
const requests = () => log.filter((l) => /^(GET|POST|DELETE) /.test(l));

describe('locked-phone stop alerts in the service worker', () => {
  it('shows a new, higher stage with sound, saves it, then acknowledges it', async () => {
    await push();
    expect(shown).toEqual([{ title: 'Dale: your stop', options: expect.objectContaining({ body: '3 stops to Port Authority', tag: 'dale-ride-alert', renotify: true, silent: false, lang: 'en' }) }]);
    expect(record).toMatchObject({ highestShown: 1, shown: { title: 'Dale: your stop', body: '3 stops to Port Authority' } });
    // Saved before it is shown, and acknowledged only after both.
    expect(log.filter((l) => ['write', 'show'].includes(l) || l.startsWith('POST'))).toEqual(['write', 'show', `POST /v1/ride-alerts/${RIDE}/ack {"stage":"three"}`]);
    expect(requests()[0]).toBe(`GET /v1/ride-alerts/${RIDE}/latest`);
  });

  it('a duplicate push after the rider dismissed the first notification stays silent', async () => {
    await push();
    await push(); // the same stage again (a retried push, or a lost acknowledgement)
    expect(shown).toHaveLength(2);
    expect(shown[1]!.options).toMatchObject({ body: '3 stops to Port Authority', renotify: false, silent: true, tag: 'dale-ride-alert' });
    // The lost acknowledgement is sent again, without a second sound.
    expect(requests().filter((r) => r.includes('/ack'))).toHaveLength(2);
  });

  it('handles pushes one at a time, and an out-of-order older answer never replaces or sounds over a newer stage', async () => {
    const answers = [stage('one', 3, 'Next stop is yours: Port Authority.'), stage('two', 2, '2 stops to Port Authority')];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    server = async (url) => {
      if (!url.endsWith('/latest')) return json({ v: 1 });
      const answer = answers[calls++]!;
      if (calls === 1) await gate; // the first answer is slow
      return json(answer);
    };
    const first = push(), second = push();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1); // the second push waits for the first
    release();
    await Promise.all([first, second]);
    expect(shown.map((s) => [s.options.body, s.options.silent])).toEqual([
      ['Next stop is yours: Port Authority.', false],
      ['Next stop is yours: Port Authority.', true], // the older "2 stops" answer re-shows the newer line silently
    ]);
    expect(record).toMatchObject({ highestShown: 3 });
  });

  it('a slow answer whose bus position is over 2 minutes old by display time shows "can\'t check" and is not acknowledged', async () => {
    server = async (url) => {
      if (!url.endsWith('/latest')) return json({ v: 1 });
      const answer = stage('two', 2, '2 stops to Port Authority', clock - 100_000); // 100 s old when sent
      clock += 30_000; // the answer took 30 s to arrive
      return json(answer);
    };
    await push();
    expect(shown).toEqual([{ title: 'Dale: your stop', options: expect.objectContaining({ body: 'Dale can’t check your bus right now. Open Dale.', silent: true }) }]);
    expect(requests().some((r) => r.includes('/ack'))).toBe(false);
    expect(record).toMatchObject({ highestShown: 0 });
  });

  it('a failed check shows "can\'t check" in the ride\'s language and acknowledges nothing', async () => {
    record = makeRecord({ lang: 'es', text: text('es') });
    server = async () => { throw new TypeError('offline'); };
    await push();
    expect(shown[0]).toMatchObject({ title: 'Dale: tu parada', options: { body: 'Dale no puede revisar tu autobús ahora. Abre Dale.', silent: true, lang: 'es' } });
    expect(requests().filter((r) => r.startsWith('POST'))).toEqual([]);
    server = async () => new Response('busy', { status: 503 });
    await push();
    expect(shown[1]!.options.body).toBe('Dale no puede revisar tu autobús ahora. Abre Dale.');
  });

  it('an ended ride (410) shows the silent ended line in the ride\'s language', async () => {
    record = makeRecord({ lang: 'es', text: text('es') });
    server = async () => json({ v: 1, kind: 'ended', reason: 'arrived' }, 410);
    await push();
    expect(shown).toEqual([{ title: 'Dale', options: expect.objectContaining({ body: 'Tu alerta de parada de Dale terminó.', silent: true, renotify: false }) }]);
  });

  it('server "not checkable" answers are shown as sent, silently, without acknowledgement', async () => {
    server = async () => json({ v: 1, kind: 'uncertain', title: 'Dale: your stop', body: 'Dale can’t check your bus right now. Open Dale.' });
    await push();
    expect(shown[0]!.options).toMatchObject({ silent: true, body: 'Dale can’t check your bus right now. Open Dale.' });
    expect(requests().filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('a service change is shown once with sound, saved, then acknowledged; repeats are silent and acknowledged again', async () => {
    server = async (url) => url.endsWith('/latest') ? json({ v: 1, kind: 'service_change', title: 'Dale: your stop', body: 'Stops on this trip changed. Open Dale.' }) : json({ v: 1 });
    await push();
    expect(shown[0]!.options).toMatchObject({ silent: false, renotify: true, body: 'Stops on this trip changed. Open Dale.' });
    expect(record).toMatchObject({ noticeShown: true });
    expect(log.filter((l) => ['write', 'show'].includes(l) || l.startsWith('POST'))).toEqual(['write', 'show', `POST /v1/ride-alerts/${RIDE}/notice-ack {}`]);
    await push();
    expect(shown[1]!.options).toMatchObject({ silent: true, renotify: false });
    expect(requests().filter((r) => r.includes('/notice-ack'))).toHaveLength(2);
  });

  it('a push for a replaced ride is never shown: the old ride is dropped and only the silent ended line appears', async () => {
    record = makeRecord({ endpoint: 'https://fcm.googleapis.com/fcm/send/old' });
    await push();
    expect(requests()).toEqual([`DELETE /v1/ride-alerts/${RIDE}`]);
    expect(shown).toEqual([{ title: 'Dale', options: expect.objectContaining({ body: 'Your Dale stop alert has ended. / Tu alerta de parada de Dale terminó.', silent: true }) }]);
  });

  it('a ride replaced while its answer was on the way never shows the old ride\'s line', async () => {
    server = async (url) => {
      if (url.includes(RIDE) && url.endsWith('/latest')) {
        record = makeRecord({ rideId: NEW_RIDE }); // the app registered the next ride meanwhile
        return json(stage('one', 3, 'OLD RIDE: next stop is yours.'));
      }
      return url.endsWith('/latest') ? json(stage('three', 1, 'NEW RIDE: 3 stops to go')) : json({ v: 1 });
    };
    await push();
    expect(shown.map((s) => s.options.body)).toEqual(['NEW RIDE: 3 stops to go']);
    expect(requests().filter((r) => r.includes('/ack'))).toEqual([`POST /v1/ride-alerts/${NEW_RIDE}/ack {"stage":"three"}`]);
  });

  it('with no ride record it shows the silent bilingual ended line and asks nothing of the server', async () => {
    record = undefined;
    await push();
    expect(requests()).toEqual([]);
    expect(shown[0]!.options).toMatchObject({ body: 'Your Dale stop alert has ended. / Tu alerta de parada de Dale terminó.', silent: true });
  });

  it('a ride that ended while its answer was on the way shows the ended line, not the stage', async () => {
    server = async (url) => { if (url.endsWith('/latest')) record = undefined; return json(stage('one', 3, 'Next stop is yours.')); };
    await push();
    expect(shown.map((s) => s.options.body)).toEqual(['Your Dale stop alert has ended. / Tu alerta de parada de Dale terminó.']);
    expect(requests().some((r) => r.includes('/ack'))).toBe(false);
  });

  it('a ride the page ended or replaced after the worker\'s transaction, before display, is not shown or acknowledged', async () => {
    afterWrite = () => { afterWrite = undefined; record = undefined; }; // the rider got off right after the save
    await push();
    expect(shown.map((s) => s.options.body)).toEqual(['Your Dale stop alert has ended. / Tu alerta de parada de Dale terminó.']);
    expect(shown[0]!.options).toMatchObject({ silent: true, renotify: false });
    expect(record).toBeUndefined();
    expect(requests().some((r) => r.includes('/ack'))).toBe(false);
    // Replaced by the next ride instead: the old ride's line is not shown, and the new ride's record is untouched.
    record = makeRecord();
    afterWrite = () => { afterWrite = undefined; record = makeRecord({ rideId: NEW_RIDE }); };
    await push();
    expect(shown.slice(1).map((s) => s.options.body)).toEqual(['Your Dale stop alert has ended. / Tu alerta de parada de Dale terminó.']);
    expect(record).toMatchObject({ rideId: NEW_RIDE, highestShown: 0 });
    expect(requests().some((r) => r.includes('/ack'))).toBe(false);
  });

  it('a record that cannot be read again before display shows "can\'t check", puts the marker back and acknowledges nothing', async () => {
    const read = io.read;
    afterWrite = () => { afterWrite = undefined; io.read = async () => { throw new DOMException('Read failed', 'UnknownError'); }; };
    await push();
    expect(shown[0]!.options).toMatchObject({ body: 'Dale can’t check your bus right now. Open Dale.', silent: true });
    expect(record).toMatchObject({ highestShown: 0 });
    expect(requests().some((r) => r.includes('/ack'))).toBe(false);
    io.read = read;
  });

  it('a service change whose record cannot be read again before display puts the notice marker back, so it still sounds later', async () => {
    const read = io.read;
    server = async (url) => url.endsWith('/latest') ? json({ v: 1, kind: 'service_change', title: 'Dale: your stop', body: 'Stops on this trip changed. Open Dale.' }) : json({ v: 1 });
    afterWrite = () => { afterWrite = undefined; io.read = async () => { throw new DOMException('Read failed', 'UnknownError'); }; };
    await push();
    expect(shown[0]!.options).toMatchObject({ body: 'Dale can’t check your bus right now. Open Dale.', silent: true });
    expect(record).toMatchObject({ noticeShown: false });
    expect(requests().some((r) => r.includes('/notice-ack'))).toBe(false);
    io.read = read;
    await push();
    expect(shown[1]!.options).toMatchObject({ body: 'Stops on this trip changed. Open Dale.', silent: false, renotify: true });
    expect(record).toMatchObject({ noticeShown: true });
  });

  it('a position that turns over 2 minutes old during the last read before display shows "can\'t check" and puts the marker back', async () => {
    const read = io.read;
    server = async (url) => url.endsWith('/latest') ? json(stage('two', 2, '2 stops to Port Authority', clock - 119_000)) : json({ v: 1 });
    afterWrite = () => { afterWrite = undefined; io.read = async () => { clock += 2_000; return read(); }; }; // the read took 2 s
    await push();
    expect(shown[0]!.options).toMatchObject({ body: 'Dale can’t check your bus right now. Open Dale.', silent: true });
    expect(record).toMatchObject({ highestShown: 0 });
    expect(requests().some((r) => r.includes('/ack'))).toBe(false);
    io.read = read;
  });

  it('a new stage or notice whose marker cannot be saved is shown silently and not acknowledged', async () => {
    failWrite = true;
    await push();
    expect(shown[0]!.options).toMatchObject({ body: '3 stops to Port Authority', silent: true, renotify: false });
    expect(record).toMatchObject({ highestShown: 0 });
    server = async (url) => url.endsWith('/latest') ? json({ v: 1, kind: 'service_change', title: 'Dale: your stop', body: 'Stops on this trip changed. Open Dale.' }) : json({ v: 1 });
    await push();
    expect(shown[1]!.options).toMatchObject({ body: 'Stops on this trip changed. Open Dale.', silent: true, renotify: false });
    expect(record).toMatchObject({ noticeShown: false });
    expect(requests().filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('a position that is over 2 minutes old once the write is done shows "can\'t check", puts the marker back and acknowledges nothing', async () => {
    server = async (url) => url.endsWith('/latest') ? json(stage('two', 2, '2 stops to Port Authority', clock - 100_000)) : json({ v: 1 });
    afterWrite = () => { afterWrite = undefined; clock += 30_000; }; // the write took 30 s
    await push();
    expect(shown).toEqual([{ title: 'Dale: your stop', options: expect.objectContaining({ body: 'Dale can’t check your bus right now. Open Dale.', silent: true }) }]);
    expect(requests().some((r) => r.includes('/ack'))).toBe(false);
    expect(record).toMatchObject({ highestShown: 0 });
    expect(record!.shown).toBeUndefined();
    // So the stage still sounds once a fresh answer arrives.
    server = async (url) => url.endsWith('/latest') ? json(stage('two', 2, '2 stops to Port Authority')) : json({ v: 1 });
    await push();
    expect(shown[1]!.options).toMatchObject({ body: '2 stops to Port Authority', silent: false });
  });

  it('a position that is stale once a failed marker write is over shows "can\'t check", never the stage text', async () => {
    server = async (url) => url.endsWith('/latest') ? json(stage('two', 2, '2 stops to Port Authority', clock - 100_000)) : json({ v: 1 });
    const update = io.update;
    // The marker transaction fails, and takes 30 s doing so.
    io.update = async (change) => { change(record ? structuredClone(record) : undefined); clock += 30_000; throw new DOMException('Storage full', 'QuotaExceededError'); };
    await push();
    expect(shown).toEqual([{ title: 'Dale: your stop', options: expect.objectContaining({ body: 'Dale can’t check your bus right now. Open Dale.', silent: true }) }]);
    expect(requests().some((r) => r.includes('/ack'))).toBe(false);
    // Nothing was saved, so nothing is rolled back over the record.
    expect(log.filter((l) => l === 'write')).toEqual([]);
    expect(record).toMatchObject({ highestShown: 0 });
    io.update = update;
  });

  it('a stale position whose marker put-back fails once is put back on the second try, so the stage still sounds later', async () => {
    server = async (url) => url.endsWith('/latest') ? json(stage('two', 2, '2 stops to Port Authority', clock - 100_000)) : json({ v: 1 });
    afterWrite = () => { afterWrite = undefined; clock += 30_000; }; // the write took 30 s
    const update = io.update;
    let calls = 0;
    io.update = async (change) => { calls++; if (calls === 2) throw new DOMException('Transaction aborted', 'AbortError'); return update(change); };
    await push();
    expect(calls).toBe(3);
    expect(shown[0]!.options).toMatchObject({ body: 'Dale can’t check your bus right now. Open Dale.', silent: true });
    expect(record).toMatchObject({ highestShown: 0 });
    io.update = update;
    server = async (url) => url.endsWith('/latest') ? json(stage('two', 2, '2 stops to Port Authority')) : json({ v: 1 });
    await push();
    expect(shown[1]!.options).toMatchObject({ body: '2 stops to Port Authority', silent: false });
  });

  it('never restores or shows a ride the page ended or replaced between the worker\'s read and its write', async () => {
    beforeUpdate = () => { beforeUpdate = undefined; record = undefined; }; // the rider got off
    await push();
    expect(record).toBeUndefined();
    expect(shown.map((s) => s.options.body)).toEqual(['Your Dale stop alert has ended. / Tu alerta de parada de Dale terminó.']);
    expect(requests().some((r) => r.includes('/ack'))).toBe(false);
    // The page saved the next ride instead: ride A's line is never shown or saved over it.
    server = async (url) => url.includes(NEW_RIDE) ? json(stage('three', 1, 'NEW RIDE: 3 stops to go')) : json(stage('one', 3, 'OLD RIDE: next stop is yours.'));
    record = makeRecord();
    beforeUpdate = () => { beforeUpdate = undefined; record = makeRecord({ rideId: NEW_RIDE }); };
    await push();
    expect(shown.slice(1).map((s) => s.options.body)).toEqual(['NEW RIDE: 3 stops to go']);
    expect(record).toMatchObject({ rideId: NEW_RIDE, highestShown: 1 });
    expect(requests().filter((r) => r.includes('/ack'))).toEqual([`POST /v1/ride-alerts/${NEW_RIDE}/ack {"stage":"three"}`]);
  });

  describe('stalled requests', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
    afterEach(() => { vi.useRealTimers(); });
    it('a stalled acknowledgement or cleanup is given up after the same timeout as the check, and later pushes go on', async () => {
      const stall = new Promise<Response>(() => {});
      server = async (url, init) => init?.method ? stall : json(stage('three', 1, '3 stops to Port Authority'));
      const first = push();
      let done = false; void first.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(19_000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(done).toBe(true);
      expect(requests().at(-1)).toBe(`POST /v1/ride-alerts/${RIDE}/ack {"stage":"three"}`);
      // The cleanup delete for a ride that is not this browser's current one stalls the same way.
      endpoint = 'https://fcm.googleapis.com/fcm/send/other';
      const second = push(), third = push();
      await vi.advanceTimersByTimeAsync(20_000);
      await second;
      expect(requests().at(-1)).toBe(`DELETE /v1/ride-alerts/${RIDE}`);
      await vi.advanceTimersByTimeAsync(20_000);
      await third;
      expect(shown.map((s) => s.options.body)).toEqual(['3 stops to Port Authority',
        'Your Dale stop alert has ended. / Tu alerta de parada de Dale terminó.', 'Your Dale stop alert has ended. / Tu alerta de parada de Dale terminó.']);
    });
  });

  it('a tapped notification focuses an open Dale, or opens it', async () => {
    let focused = 0, closed = 0;
    const tap = async () => {
      let kept: Promise<unknown> = Promise.resolve();
      handlers.notificationclick!({ notification: { close: () => { closed++; } }, waitUntil: (p) => { kept = p; } });
      await kept;
    };
    await tap();
    expect(log).toContain(`open ${ORIGIN}/dale/`);
    clients.matchAll = async () => [{ url: `${ORIGIN}/dale/?live=1`, focus: async () => { focused++; } }];
    await tap();
    expect(focused).toBe(1);
    expect(closed).toBe(2);
  });
});
