// Payload-less Web Push (#176 step C, docs/LOCKED_STOP_ALERTS.md step 6). The push carries no data, so
// only a VAPID-signed request (RFC 8292) is needed, not message encryption. WebCrypto only, no package.
// The endpoint is a capability URL: it is never logged, returned or shown in health output.

export const VAPID_SUBJECT = 'https://jwchr.github.io/dale/';
/** Seconds the push service may hold an undelivered push. A late stop alert is dropped, not delivered late. */
export const PUSH_TTL_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 12 * 3600;
const PUSH_TIMEOUT_MS = 10_000;

/** ok: accepted (not shown); gone: 404/410, the subscription no longer exists; retry: network error, 429 or 5xx. */
export type PushResult = 'ok' | 'gone' | 'retry' | 'failed';
export interface Vapid { key: CryptoKey; publicKey: string }

export function toBase64Url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return;
  try {
    const text = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4));
    const bytes = new Uint8Array(new ArrayBuffer(text.length));
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  } catch { return; }
}

let cached: { raw: string; value: Promise<Vapid | undefined> } | undefined;

/**
 * The owner-set `VAPID_PRIVATE_KEY` secret: a JSON P-256 private JWK. The public key (uncompressed point,
 * base64url) is derived from its x and y, and checked against the private part with one signature, so a
 * mismatched secret answers "not available" instead of sending pushes no browser accepts.
 */
export function loadVapid(raw: string | undefined): Promise<Vapid | undefined> {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return Promise.resolve(undefined);
  if (cached?.raw === raw) return cached.value;
  const value = (async (): Promise<Vapid | undefined> => {
    let jwk: unknown;
    try { jwk = JSON.parse(raw); } catch { return; }
    if (!jwk || typeof jwk !== 'object') return;
    const { kty, crv, x, y, d } = jwk as Record<string, unknown>;
    if (kty !== 'EC' || crv !== 'P-256' || typeof x !== 'string' || typeof y !== 'string' || typeof d !== 'string') return;
    const xs = fromBase64Url(x), ys = fromBase64Url(y), ds = fromBase64Url(d);
    if (xs?.length !== 32 || ys?.length !== 32 || ds?.length !== 32) return;
    try {
      const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
      const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, d }, algorithm, false, ['sign']);
      const point = new Uint8Array(65);
      point[0] = 4; point.set(xs, 1); point.set(ys, 33);
      const publicKey = await crypto.subtle.importKey('raw', point, algorithm, false, ['verify']);
      const probe = new TextEncoder().encode('dale-vapid-check');
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, probe);
      if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, probe)) return;
      return { key, publicKey: toBase64Url(point) };
    } catch { return; }
  })();
  cached = { raw, value };
  return value;
}

/** ES256 JWT for one push service origin (RFC 8292 section 2), valid for 12 hours. */
export async function vapidJwt(vapid: Vapid, audience: string, now: number): Promise<string> {
  const part = (value: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: audience, exp: Math.floor(now / 1000) + JWT_LIFETIME_SECONDS, sub: VAPID_SUBJECT })}`;
  // WebCrypto ECDSA signatures are already the raw r||s form JWS uses.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Send one empty push. `topic` (the ride id) lets the push service replace an older undelivered push for the
 * same ride; TTL 60 drops one the phone has not received within a minute. Redirects are never followed.
 */
export async function sendPush(vapid: Vapid, endpoint: string, topic: string, now: number, fetchImpl: typeof fetch = fetch): Promise<PushResult> {
  let audience: string;
  try { audience = new URL(endpoint).origin; } catch { return 'failed'; }
  let response: Response;
  try {
    const jwt = await vapidJwt(vapid, audience, now);
    response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(PUSH_TIMEOUT_MS), body: new Uint8Array(0),
      headers: { authorization: `vapid t=${jwt}, k=${vapid.publicKey}`, ttl: String(PUSH_TTL_SECONDS), topic, urgency: 'high' },
    });
  } catch { return 'retry'; }
  try { await response.body?.cancel(); } catch { /* the answer's body is never read */ }
  if (response.status >= 200 && response.status < 300) return 'ok';
  if (response.status === 404 || response.status === 410) return 'gone';
  if (response.status === 429 || response.status >= 500) return 'retry';
  return 'failed';
}
