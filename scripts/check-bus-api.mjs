#!/usr/bin/env node
// Bus default: authentication only. Explicit reviewed rail scope delegates to its bounded checker.
// Never log, return or persist credentials, tokens or response bodies.
import { pathToFileURL } from 'node:url';
import { runRailConnectionCheck } from './check-rail-api.mjs';

const APIS = ['BUSDV2', 'GTFSG2'];
const HOST = 'https://pcsdata.njtransit.com';
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16_384;

async function readObject(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

async function checkOne(api, credentials, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const body = new FormData();
    body.set('username', credentials.username);
    body.set('password', credentials.password);
    const response = await fetchImpl(`${HOST}/api/${api}/authenticateUser`, {
      method: 'POST', body, headers: { accept: 'application/json' },
      redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return 'access-denied';
    if (response.status === 429) return 'rate-limited';
    if (!response.ok) return 'http-error';
    const value = await readObject(response);
    // The official schemas use PascalCase strings, not JavaScript truthiness ("False" is truthy).
    const flag = value?.Authenticated;
    if (flag === false || (typeof flag === 'string' && flag.trim().toLowerCase() === 'false')) return 'access-denied';
    if (flag !== true && !(typeof flag === 'string' && flag.trim().toLowerCase() === 'true')) return 'unexpected-response';
    return typeof value.UserToken === 'string' && value.UserToken.trim().length > 0
      ? 'authenticated' : 'unexpected-response';
  } catch {
    // Error messages and server bodies can echo secrets. Only this fixed vocabulary leaves the checker.
    return controller.signal.aborted ? 'timed-out' : 'network-error';
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function checkBusApiCredentials(credentials, fetchImpl = globalThis.fetch) {
  if (typeof credentials?.username !== 'string' || !credentials.username.trim()
    || typeof credentials?.password !== 'string' || !credentials.password.trim()) {
    return APIS.map((api) => ({ api, status: 'configuration-missing' }));
  }
  const results = [];
  // At most one attempt per approved API. No retries, polling, feed downloads or rail requests.
  for (const api of APIS) results.push({ api, status: await checkOne(api, credentials, fetchImpl) });
  return results;
}

export async function runConnectionCheck(env = process.env, fetchImpl = globalThis.fetch, log = console.log) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_REPOSITORY !== 'jwchr/dale') {
    log('Run this check through the manual Dale workflow on main. No request was sent.');
    return 2;
  }
  if (env.NJT_API_CHECK_SCOPE === 'rail') return runRailConnectionCheck(env, fetchImpl, log);
  if (env.NJT_API_CHECK_SCOPE && env.NJT_API_CHECK_SCOPE !== 'bus') {
    log('Unknown API check scope. No request sent.'); return 2;
  }
  try {
    const results = await checkBusApiCredentials({ username: env.NJT_API_USERNAME, password: env.NJT_API_PASSWORD }, fetchImpl);
    for (const result of results) log(`${result.api}: ${result.status}`);
    log('Authentication check only. The rider-facing app is not connected to live data by this check.');
    return results.every((result) => result.status === 'authenticated') ? 0 : 1;
  } catch {
    log('Connection check failed unexpectedly. No response details are logged.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runConnectionCheck();
}
