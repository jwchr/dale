// Dale service worker, built for the Lincoln Tunnel and terminal basements.
// - The page and the schedule JSON are fetched fresh (cache: 'no-cache'), so the browser's copy of an old page
//   (GitHub Pages sends max-age=600) is not run against newer data after a deploy.
// - If the network has not answered within NETWORK_TIMEOUT_MS, fails, or answers with a server error, the saved
//   copy is used and marked `x-arriba-from-cache: 1`. `x-arriba-saved-at` (ms since epoch) says when it was saved;
//   copies saved by older versions carry only the server's `Date` header. The network request is kept alive with
//   waitUntil so it can still refresh the saved copy, unless the page cancels it.
// - Vite's hashed /assets/ files never change, so their saved copy is used first.
// - Pages are saved under one address without the query string, so `?now=` and `?demo` share the newest page.
// - Install saves the page, its assets and the schedule, so the app works offline after the first visit.
// - The map file (/map/*.pmtiles) is read in byte ranges: each range is saved on its own, so map areas the
//   rider has already looked at work offline. Map fonts and icons never change, so their saved copy is used.
// tests/unit/sw.test.ts runs this file against stand-in fetch and caches.
// Cache and header names keep the app's first name (Arriba) so saved copies survive the rename to Dale.
const CACHE = 'arriba-v1';
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(precache().catch(() => { /* the first online load saves them instead */ }));
});
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const { response, done } = url.pathname.endsWith('.pmtiles') ? rangeSaved(req, url)
    : url.pathname.includes('/assets/') || url.pathname.includes('/map/') ? savedFirst(req) : networkFirst(req, url);
  e.respondWith(response);
  e.waitUntil(done);
});

/** Cache key: pages without their query string, everything else as requested. */
function keyFor(req, url) {
  return req.mode === 'navigate' ? url.origin + url.pathname : req.url;
}

async function save(key, res) {
  const headers = new Headers(res.headers);
  headers.set('x-arriba-saved-at', String(Date.now()));
  const copy = new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
  await (await caches.open(CACHE)).put(key, copy);
}

/** The network answer, and a promise that settles once a good answer is saved. */
function fetchAndSave(req, key, init) {
  const response = fetch(req, init);
  const done = response.then((res) => (res.ok ? save(key, res.clone()) : undefined)).catch(() => {});
  return { response, done };
}

async function precache() {
  const page = new URL('./', self.location.href).href;
  const res = await fetch(page, { cache: 'no-cache' });
  if (!res.ok) return;
  const html = await res.clone().text();
  await save(page, res);
  const assets = [...new Set(html.match(/[^"'\s()]*assets\/[^"'\s()]+/g) || [])].map((p) => new URL(p, page).href);
  await Promise.all([new URL('data/corridor.json', page).href, ...assets].map(async (u) => {
    const r = await fetch(u, { cache: 'no-cache' });
    if (r.ok) await save(u, r);
  }));
}

function savedFirst(req) {
  const result = caches.match(req).then((hit) => {
    if (hit) return { res: hit, done: undefined };
    const net = fetchAndSave(req, req.url);
    return net.response.then((res) => ({ res, done: net.done }));
  });
  return { response: result.then((r) => r.res), done: result.then((r) => r.done, () => {}) };
}

/** One saved copy per byte range of the map file (the file name carries its build date, so it never changes). */
function rangeSaved(req, url) {
  const range = (req.headers && req.headers.get && req.headers.get('range')) || '';
  // A query parameter, not a #fragment: the Cache API ignores fragments when matching.
  const key = `${url.origin}${url.pathname}?dale-range=${encodeURIComponent(range)}`;
  const result = caches.match(key).then(async (hit) => {
    if (hit) return { res: await asPartial(hit), done: undefined };
    const res = await fetch(req);
    // The Cache API cannot hold a 206; keep the bytes as a 200 with the range it covered. A whole-file
    // answer (no range, or a server that ignored it) is not kept: the map file is 19 MB.
    const small = res.status === 200 && Number(res.headers.get('content-length') || Infinity) <= MAX_WHOLE_BYTES;
    const done = (res.status === 206 || small) ? (async () => {
      const headers = new Headers({ 'content-type': res.headers.get('content-type') || 'application/octet-stream' });
      const cr = res.headers.get('content-range');
      if (cr) headers.set('x-dale-content-range', cr);
      const cache = await caches.open(CACHE);
      await cache.put(key, new Response(await res.clone().blob(), { status: 200, headers }));
      await dropOtherMapFiles(cache, url.pathname);
    })().catch(() => {}) : undefined;
    return { res, done };
  });
  return { response: result.then((r) => r.res), done: result.then((r) => r.done, () => {}) };
}

const MAX_WHOLE_BYTES = 1_000_000;
let mapFileInUse = '';
/** Once a map file is in use, pieces saved from an older one (an earlier dated build) are dropped. */
async function dropOtherMapFiles(cache, pathname) {
  if (mapFileInUse === pathname || !cache.keys) return;
  mapFileInUse = pathname;
  for (const k of await cache.keys()) {
    const u = new URL(typeof k === 'string' ? k : k.url);
    if (u.pathname.endsWith('.pmtiles') && u.pathname !== pathname) await cache.delete(k);
  }
}

async function asPartial(hit) {
  const cr = hit.headers.get('x-dale-content-range');
  const body = await hit.blob();
  if (!cr) return new Response(body, { status: 200, headers: { 'content-type': hit.headers.get('content-type') || 'application/octet-stream' } });
  return new Response(body, { status: 206, headers: { 'content-type': hit.headers.get('content-type') || 'application/octet-stream', 'content-range': cr, 'content-length': String(body.size) } });
}

async function markSaved(hit) {
  const headers = new Headers(hit.headers);
  headers.set('x-arriba-from-cache', '1');
  return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
}

function networkFirst(req, url) {
  const fresh = req.mode === 'navigate' || /\.(json|html)$/.test(url.pathname);
  const key = keyFor(req, url);
  const net = fetchAndSave(req, key, fresh ? { cache: 'no-cache' } : undefined);
  net.response.catch(() => {}); // a failure after the saved copy was used is not an error
  const saved = async () => (await caches.match(key)) || (req.mode === 'navigate' ? caches.match(req, { ignoreSearch: true }) : undefined);
  const response = (async () => {
    let timer;
    const timedOut = new Promise((resolve) => { timer = setTimeout(resolve, NETWORK_TIMEOUT_MS, 'timeout'); });
    let first;
    try {
      first = await Promise.race([net.response, timedOut]);
    } catch {
      first = 'failed';
    } finally {
      clearTimeout(timer);
    }
    // 404 passes through (the app treats a missing dataset as "no data published"); server errors fall back.
    if (first instanceof Response && first.status < 500) return first;
    const hit = await saved();
    if (hit) return markSaved(hit);
    return first instanceof Response ? first : net.response;
  })();
  return { response, done: net.done };
}

// ---- Stop alerts while the phone is locked (#176 step C; docs/LOCKED_STOP_ALERTS.md, flow step 7) ----
// A push carries no data. The worker reads the ride record the app saved (IndexedDB `dale-ride-alerts`),
// checks it belongs to this browser's current push address, asks Dale's server for the ride's answer now,
// and shows it under one notification tag. Pushes are handled one at a time, and the record is read again,
// compared and updated in one readwrite transaction just before anything is shown, so a slow or out-of-order
// answer never replaces or sounds over a newer stage, and a ride the page ended or replaced meanwhile is never
// restored. Only a stage that was saved here is acknowledged to the server; a stage or notice whose marker
// could not be saved is shown silently. Every request to Dale's server is bounded by RIDE_FETCH_TIMEOUT_MS.
// tests/unit/swRideAlerts.test.ts runs these handlers with stand-ins.
const RIDE_TAG = 'dale-ride-alert';
const RIDE_MAX_AGE_MS = 120000;
const RIDE_FETCH_TIMEOUT_MS = 20000;
const RIDE_ENDED_ANY = { title: 'Dale', body: 'Your Dale stop alert has ended. / Tu alerta de parada de Dale terminó.' };
const RIDE_CANT_CHECK_ANY = { title: 'Dale', body: 'Dale can’t check your bus right now. Open Dale. / Dale no puede revisar tu autobús ahora. Abre Dale.' };

/** Runs `act` on the ride store in one transaction; resolves with `out.value` once the transaction completes. */
function rideStore(mode, act) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('dale-ride-alerts', 1);
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains('ride')) open.result.createObjectStore('ride'); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      let tx;
      try { tx = db.transaction('ride', mode); } catch (error) { db.close(); reject(error); return; }
      const out = {};
      tx.oncomplete = () => { db.close(); resolve(out.value); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('ride store')); };
      try { act(tx.objectStore('ride'), out, tx); } catch { try { tx.abort(); } catch { /* already finished */ } }
    };
  });
}

/**
 * Reads the record and, in the same readwrite transaction, writes what `change(record)` returns (nothing when it
 * returns undefined). The page cannot delete or replace the record between that read and that write.
 */
function rideUpdate(change) {
  return rideStore('readwrite', (store, out, tx) => {
    const get = store.get('current');
    get.onsuccess = () => {
      try {
        const next = change(get.result);
        if (next) store.put(next, 'current');
      } catch { try { tx.abort(); } catch { /* already finished */ } }
    };
  });
}

/** Everything the push handler touches outside itself; the unit test swaps these for stand-ins. */
const rideIo = {
  read: () => rideStore('readonly', (store, out) => { const get = store.get('current'); get.onsuccess = () => { out.value = get.result; }; }),
  update: (change) => rideUpdate(change),
  subscription: () => self.registration.pushManager.getSubscription(),
  fetch: (url, init) => fetch(url, init),
  show: (title, options) => self.registration.showNotification(title, options),
  now: () => Date.now(),
};

const isNote = (n) => !!n && typeof n.title === 'string' && typeof n.body === 'string';
function validRideRecord(r) {
  return !!r && typeof r === 'object' && typeof r.rideId === 'string' && /^[A-Za-z0-9_-]{22}$/.test(r.rideId)
    && typeof r.endpoint === 'string' && typeof r.apiBase === 'string' && /^https:\/\/dale-live\.[a-z0-9-]+\.workers\.dev$/.test(r.apiBase)
    && (r.lang === 'en' || r.lang === 'es') && typeof r.highestShown === 'number' && !!r.text && isNote(r.text.cantCheck) && isNote(r.text.ended);
}
const rideUrl = (r, suffix) => `${r.apiBase}/v1/ride-alerts/${encodeURIComponent(r.rideId)}${suffix}`;
const sameRide = (r, record) => validRideRecord(r) && r.rideId === record.rideId && r.endpoint === record.endpoint;

/**
 * One request to Dale's server and the reading of its answer, given up after RIDE_FETCH_TIMEOUT_MS (aborted,
 * and not waited for even if the request ignores the abort), so a stalled request never holds up later pushes.
 * Resolves with `read(response)`, or `fallback` after a failure or the timeout.
 */
async function rideFetch(io, url, init, read, fallback) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : undefined;
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => { if (ctl) ctl.abort(); resolve(fallback); }, RIDE_FETCH_TIMEOUT_MS); });
  const answer = Promise.resolve().then(() => io.fetch(url, { ...init, signal: ctl && ctl.signal })).then(read).catch(() => fallback);
  try {
    return await Promise.race([answer, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** The server's answer now: `{ kind: 'answer', body }`, `{ kind: 'ended' }` (410/404) or `{ kind: 'failed' }`. */
function fetchRideLatest(io, record) {
  return rideFetch(io, rideUrl(record, '/latest'), { cache: 'no-store', credentials: 'omit' }, async (res) => {
    if (res.status === 410 || res.status === 404) return { kind: 'ended' };
    if (res.status !== 200) return { kind: 'failed' };
    return { kind: 'answer', body: await res.json() };
  }, { kind: 'failed' });
}

/**
 * What to show for an answer, given the ride record as it is now and the time of showing. Only a stage
 * higher than the highest already shown sounds and is saved; a repeated or lower one re-shows that highest
 * line silently. A position more than 2 minutes old by now (the fetch time counts) is "can't check" and is
 * not acknowledged, so the server pushes the current stage again.
 */
function ridePlan(record, answer, now) {
  const cantCheck = { note: record.text.cantCheck, silent: true };
  if (answer.kind === 'ended') return { note: record.text.ended, silent: true };
  if (answer.kind !== 'answer' || !answer.body || answer.body.v !== 1) return cantCheck;
  const b = answer.body;
  if (b.kind === 'service_change' && isNote(b)) {
    const note = { title: b.title, body: b.body };
    return record.noticeShown ? { note, silent: true, noticeAck: true } : { note, silent: false, save: { noticeShown: true }, noticeAck: true };
  }
  if (b.kind === 'uncertain' && isNote(b)) return { note: { title: b.title, body: b.body }, silent: true };
  if (b.kind === 'stage' && isNote(b) && typeof b.stage === 'string' && Number.isFinite(b.rank) && Number.isFinite(b.observedAt)) {
    if (!(now - b.observedAt <= RIDE_MAX_AGE_MS)) return cantCheck;
    const note = { title: b.title, body: b.body };
    if (b.rank > record.highestShown) return { note, silent: false, save: { highestShown: b.rank, shown: note }, ack: b.stage, observedAt: b.observedAt };
    return { note: isNote(record.shown) ? record.shown : note, silent: true, ack: b.stage, observedAt: b.observedAt };
  }
  return cantCheck;
}

function showRideNote(io, note, silent, lang) {
  const options = { body: note.body, tag: RIDE_TAG, renotify: !silent, silent, icon: new URL('icon-192.png', self.location.href).href };
  if (lang) options.lang = lang;
  if (!silent) options.vibrate = [200, 100, 200];
  return io.show(note.title, options);
}

function postRide(io, record, suffix, body) {
  return rideFetch(io, rideUrl(record, suffix), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit' },
    () => undefined, undefined);
}

async function handleRidePush(io, retried) {
  const record = await Promise.resolve().then(io.read).catch(() => undefined);
  const sub = await Promise.resolve().then(io.subscription).catch(() => null);
  if (!validRideRecord(record) || !sub || sub.endpoint !== record.endpoint) {
    // Not this browser's current ride: nothing about it is shown, and the server is asked to drop it.
    if (validRideRecord(record)) await rideFetch(io, rideUrl(record, ''), { method: 'DELETE', credentials: 'omit' }, () => undefined, undefined);
    return showRideNote(io, RIDE_ENDED_ANY, true);
  }
  const answer = await fetchRideLatest(io, record);
  // Re-read, decide and save in one readwrite transaction: if the page ended this ride or saved another one
  // meanwhile, nothing is written (the old ride is never restored) and the old ride's line is never shown.
  let current, plan;
  const stored = await Promise.resolve().then(() => io.update((r) => {
    current = r;
    if (!sameRide(r, record)) return undefined;
    plan = ridePlan(r, answer, io.now());
    return plan.save ? { ...r, ...plan.save } : undefined;
  })).then(() => true, () => false);
  if (!plan) {
    // The record could not be read: nothing was checked against it, so nothing is claimed.
    if (!stored) return showRideNote(io, record.text.cantCheck, true, record.lang);
    if (validRideRecord(current) && !retried) return handleRidePush(io, true);
    return showRideNote(io, RIDE_ENDED_ANY, true);
  }
  // A new stage or notice whose marker could not be saved is shown silently and not acknowledged, so it can
  // never sound twice; the server pushes it again.
  if (!stored) return showRideNote(io, plan.note, true, current.lang);
  // The bus position must still be under 2 minutes old now that the write is done (its time counts).
  if (plan.observedAt !== undefined && !(io.now() - plan.observedAt <= RIDE_MAX_AGE_MS)) {
    // Not shown, so its marker is put back (unless something else changed it since), and nothing is acknowledged.
    if (plan.save) {
      const before = current, raised = plan.save.highestShown;
      await Promise.resolve().then(() => io.update((r) => (sameRide(r, record) && r.highestShown === raised
        ? { ...r, highestShown: before.highestShown, shown: before.shown } : undefined))).catch(() => undefined);
    }
    return showRideNote(io, current.text.cantCheck, true, current.lang);
  }
  await showRideNote(io, plan.note, plan.silent, current.lang);
  if (plan.ack) await postRide(io, current, '/ack', { stage: plan.ack });
  if (plan.noticeAck) await postRide(io, current, '/notice-ack', {});
}

let ridePushChain = Promise.resolve();
self.addEventListener('push', (e) => {
  const run = ridePushChain.then(() => handleRidePush(rideIo, false))
    .catch(() => showRideNote(rideIo, RIDE_CANT_CHECK_ANY, true).catch(() => {}));
  ridePushChain = run.catch(() => {});
  e.waitUntil(run);
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(openDale());
});

async function openDale() {
  const base = new URL('./', self.location.href).href;
  const open = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).find((c) => c.url.startsWith(base));
  if (open && open.focus) return open.focus();
  return self.clients.openWindow(base);
}
