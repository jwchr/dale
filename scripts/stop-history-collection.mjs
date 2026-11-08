// Authenticated settings-only stop: no script upload, schedule preparation or NJT call.
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { liveApiUrl } from '../src/domain/liveBus.ts';
// Only locally constructed, closed diagnostics may reach public Actions logs.
class StopFailure extends Error {
  constructor(reason, stage, status) { super(reason); this.reason = reason; this.stage = stage; this.status = status; }
}
export function safeStopFailure(error) {
  const stages = ['authorization', 'configuration', 'read-deployments', 'read-versions', 'read-version', 'read-settings', 'settings-patch', 'verify-active-version', 'verify-binding-state', 'verify-preservation', 'verify-disabled-health', 'verify-stability'];
  const reasons = ['manual-main-required', 'stop-configuration-invalid', 'cloudflare-stop-request-failed', 'cloudflare-stop-response-invalid', 'stop-active-version-ambiguous', 'stop-binding-state-invalid', 'stop-version-changed', 'stop-other-bindings-changed', 'stop-disabled-setting-unverified', 'stop-code-changed', 'stop-runtime-changed', 'stop-health-unavailable', 'stop-health-invalid', 'stop-disabled-unverified', 'stop-stability-unverified', 'invalid-json', 'request-timeout', 'unexpected-failure'];
  if (!(error instanceof StopFailure) || !stages.includes(error.stage) || !reasons.includes(error.reason)) return 'stage=unknown reason=unexpected-failure';
  return `stage=${error.stage} reason=${error.reason}${Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? ` http=${error.status}` : ''}`;
}
export async function stopHistoryCollection(env, { fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let stage = 'authorization';
  const failure = (reason, status) => new StopFailure(reason, stage, status);
  try {
    if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'jwchr/dale') throw failure('manual-main-required');
    stage = 'configuration';
    const url = liveApiUrl(env.DALE_WORKER_URL);
    if (!url || !env.CLOUDFLARE_API_TOKEN?.trim() || !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) throw failure('stop-configuration-invalid');
    const root = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/dale-live`;
    async function api(path, body) {
      stage = body ? 'settings-patch' : path === '/deployments' ? 'read-deployments' : path === '/versions' ? 'read-versions' : path === '/settings' ? 'read-settings' : 'read-version';
      const response = await fetchImpl(root + path, { method: body ? 'PATCH' : 'GET', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, body, signal: AbortSignal.timeout(20_000), redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw failure('cloudflare-stop-request-failed', Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined);
      const packet = await response.json();
      if (packet.success !== true || !packet.result) throw failure('cloudflare-stop-response-invalid');
      return packet.result;
    }
    async function active() {
      const deployment = (await api('/deployments')).deployments?.[0];
      const latest = (await api('/versions')).items?.[0]?.id;
      stage = 'verify-active-version';
      if (!latest || deployment?.versions?.length !== 1 || deployment.versions[0].percentage !== 100 || deployment.versions[0].version_id !== latest) throw failure('stop-active-version-ambiguous');
      return latest;
    }
    const beforeId = await active();
    const before = await api(`/versions/${encodeURIComponent(beforeId)}`);
    const settings = await api('/settings');
    const bindings = settings.bindings;
    stage = 'verify-binding-state';
    if (!before.resources?.script?.etag || !before.resources.script_runtime || !Array.isArray(bindings) || bindings.some(b => typeof b.name !== 'string' || !b.name || !b.type) || new Set(bindings.map(b => b.name)).size !== bindings.length) throw failure('stop-binding-state-invalid');
    const others = list => list.filter(b => b.name !== 'HISTORY_COLLECTION').sort((a,b) => a.name.localeCompare(b.name));
    if (await active() !== beforeId) throw failure('stop-version-changed');
    const form = new FormData();
    form.set('settings', JSON.stringify({ bindings: [...others(bindings).map(b => ({ name: b.name, type: 'inherit' })), { name: 'HISTORY_COLLECTION', type: 'plain_text', text: 'disabled' }] }));
    await api('/settings', form);
    const afterSettings = await api('/settings');
    const after = await api(`/versions/${encodeURIComponent(await active())}`);
    stage = 'verify-preservation';
    if (!Array.isArray(afterSettings.bindings) || !isDeepStrictEqual(others(bindings), others(afterSettings.bindings))) throw failure('stop-other-bindings-changed');
    if (afterSettings.bindings.filter(b => b.name === 'HISTORY_COLLECTION').length !== 1 || !afterSettings.bindings.some(b => b.name === 'HISTORY_COLLECTION' && b.type === 'plain_text' && b.text === 'disabled')) throw failure('stop-disabled-setting-unverified');
    if (after.resources?.script?.etag !== before.resources.script.etag) throw failure('stop-code-changed');
    if (!isDeepStrictEqual(after.resources?.script_runtime, before.resources.script_runtime)) throw failure('stop-runtime-changed');
    async function health() {
      // Never send the control-plane credential to this public read-only endpoint.
      const response = await fetchImpl(url + '/v1/collection', { signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw failure('stop-health-unavailable');
      const state = (await response.json()).collection;
      if (!state || state.enabled !== false || state.reason !== 'disabled' || state.alarmAt !== null || state.error) return undefined;
      const receipt = {};
      for (const key of ['lastAttemptAt', 'completedAttempt', 'observations', 'batches', 'bytes']) {
        if (state[key] !== undefined && (!Number.isSafeInteger(state[key]) || state[key] < 0)) throw failure('stop-health-invalid');
        receipt[key] = state[key];
      }
      if (receipt.observations === undefined || receipt.batches === undefined || receipt.bytes === undefined) throw failure('stop-health-invalid');
      return receipt;
    }
    stage = 'verify-disabled-health';
    let first;
    for (let attempt = 0; attempt < 15; attempt++) {
      first = await health();
      if (first) break;
      await sleep(1000);
    }
    if (!first) throw failure('stop-disabled-unverified');
    stage = 'verify-stability';
    await sleep(35_000);
    const second = await health();
    if (!second || !isDeepStrictEqual(first, second)) throw failure('stop-stability-unverified');
    console.log('History collection disabled; alarm cleared and collection counters unchanged across 35 seconds. Deployed code, other bindings and retained evidence preserved.');
  } catch (error) {
    if (error instanceof StopFailure) throw error;
    // Never forward exception messages, response bodies, URLs, identifiers or stacks.
    throw failure(error instanceof SyntaxError ? 'invalid-json' : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'request-timeout' : 'unexpected-failure');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await stopHistoryCollection(process.env); } catch (error) {
    console.error(`Stop diagnostic: ${safeStopFailure(error)}.`);
    console.error('Cloudflare-only stop was not fully verified. Check actual collection health; no automatic re-enable or evidence deletion was attempted. No credentials or raw responses logged.');
    process.exitCode = 1;
  }
}
