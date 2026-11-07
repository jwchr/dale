// Used by the private Worker and its deployment-time static-feed builder. Fixed official host only.
export type NjtEndpoint = 'authenticateUser' | 'getGTFS' | 'getVehiclePositions' | 'getTripUpdates';
export interface Credentials { NJT_API_USERNAME: string; NJT_API_PASSWORD: string }
export class NjtError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const SAFE_FAILURES = new Set(['configuration-missing', 'authentication-cooldown', 'access-denied', 'rate-limited', 'http-error', 'empty-response', 'response-too-large', 'timed-out', 'network-error', 'invalid-token', 'invalid-response', 'redirect-refused']);
/** Never expose an exception message, upstream body or arbitrary error code in diagnostics. */
export function safeNjtFailure(error: unknown): string {
  return error instanceof NjtError && SAFE_FAILURES.has(error.code) ? error.code : 'unknown-error';
}
export async function njtRequest(endpoint: NjtEndpoint, fields: Record<string, string>, maxBytes: number, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<Uint8Array> {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    const response = await fetchImpl(`https://pcsdata.njtransit.com/api/GTFSG2/${endpoint}`, {
      method: 'POST', body, redirect: 'manual', cache: 'no-store', signal: ctl.signal,
    });
    if (response.status >= 300 && response.status < 400) throw new NjtError('redirect-refused');
    if (!response.ok) throw new NjtError(response.status === 401 || response.status === 403 ? 'access-denied' : response.status === 429 ? 'rate-limited' : 'http-error');
    if (!response.body) throw new NjtError('empty-response');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { void reader.cancel().catch(() => {}); throw new NjtError('response-too-large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return bytes;
  } catch (error) {
    if (error instanceof NjtError) throw error;
    throw new NjtError(ctl.signal.aborted ? 'timed-out' : 'network-error');
  } finally { clearTimeout(timer); ctl.abort(); }
}
export async function authenticate(env: Credentials, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!env.NJT_API_USERNAME?.trim() || !env.NJT_API_PASSWORD?.trim()) throw new NjtError('configuration-missing');
  const bytes = await njtRequest('authenticateUser', { username: env.NJT_API_USERNAME, password: env.NJT_API_PASSWORD }, 16_384, fetchImpl);
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value?.Authenticated !== true && String(value?.Authenticated).toLowerCase() !== 'true') throw new NjtError('access-denied');
    if (typeof value.UserToken !== 'string' || !value.UserToken.trim()) throw new NjtError('invalid-token');
    return value.UserToken;
  } catch (error) { throw error instanceof NjtError ? error : new NjtError('invalid-response'); }
}
