// Authenticated settings-only stop: no script upload, schedule preparation or NJT call.
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { liveApiUrl } from '../src/domain/liveBus.ts';
export async function stopHistoryCollection(env, { fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'jwchr/dale') throw new Error('manual-main-required');
  const url = liveApiUrl(env.DALE_WORKER_URL);
  if (!url || !env.CLOUDFLARE_API_TOKEN?.trim() || !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) throw new Error('stop-configuration-invalid');
  const root = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/dale-live`;
  async function api(path, body) {
    const response = await fetchImpl(root + path, { method: body ? 'PATCH' : 'GET', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, body, signal: AbortSignal.timeout(20_000), redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error('cloudflare-stop-request-failed');
    const packet = await response.json();
    if (packet.success !== true || !packet.result) throw new Error('cloudflare-stop-response-invalid');
    return packet.result;
  }
  async function active() {
    const deployment = (await api('/deployments')).deployments?.[0];
    const latest = (await api('/versions')).items?.[0]?.id;
    if (!latest || deployment?.versions?.length !== 1 || deployment.versions[0].percentage !== 100 || deployment.versions[0].version_id !== latest) throw new Error('stop-active-version-ambiguous');
    return latest;
  }
  const beforeId = await active();
  const before = await api(`/versions/${encodeURIComponent(beforeId)}`);
  const settings = await api('/settings');
  const bindings = settings.bindings;
  if (!before.resources?.script?.etag || !before.resources.script_runtime || !Array.isArray(bindings) || bindings.some(b => typeof b.name !== 'string' || !b.name || !b.type) || new Set(bindings.map(b => b.name)).size !== bindings.length) throw new Error('stop-binding-state-invalid');
  const others = list => list.filter(b => b.name !== 'HISTORY_COLLECTION').sort((a,b) => a.name.localeCompare(b.name));
  if (await active() !== beforeId) throw new Error('stop-version-changed');
  const form = new FormData();
  form.set('settings', JSON.stringify({ bindings: [...others(bindings).map(b => ({ name: b.name, type: 'inherit' })), { name: 'HISTORY_COLLECTION', type: 'plain_text', text: 'disabled' }] }));
  await api('/settings', form);
  const afterSettings = await api('/settings');
  const after = await api(`/versions/${encodeURIComponent(await active())}`);
  if (!Array.isArray(afterSettings.bindings) || !isDeepStrictEqual(others(bindings), others(afterSettings.bindings)) || afterSettings.bindings.filter(b => b.name === 'HISTORY_COLLECTION').length !== 1 || !afterSettings.bindings.some(b => b.name === 'HISTORY_COLLECTION' && b.type === 'plain_text' && b.text === 'disabled') || after.resources?.script?.etag !== before.resources.script.etag || !isDeepStrictEqual(after.resources?.script_runtime, before.resources.script_runtime)) throw new Error('stop-preservation-unverified');
  async function health() {
    // Never send the control-plane credential to this public read-only endpoint.
    const response = await fetchImpl(url + '/v1/collection', { signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error('stop-health-unavailable');
    const state = (await response.json()).collection;
    if (!state || state.enabled !== false || state.reason !== 'disabled' || state.alarmAt !== null || state.error) return undefined;
    const receipt = {};
    for (const key of ['lastAttemptAt', 'completedAttempt', 'observations', 'batches', 'bytes']) {
      if (state[key] !== undefined && (!Number.isSafeInteger(state[key]) || state[key] < 0)) throw new Error('stop-health-invalid');
      receipt[key] = state[key];
    }
    if (receipt.observations === undefined || receipt.batches === undefined || receipt.bytes === undefined) throw new Error('stop-health-invalid');
    return receipt;
  }
  let first;
  for (let attempt = 0; attempt < 15; attempt++) {
    first = await health();
    if (first) break;
    await sleep(1000);
  }
  if (!first) throw new Error('stop-disabled-unverified');
  await sleep(35_000);
  const second = await health();
  if (!second || !isDeepStrictEqual(first, second)) throw new Error('stop-stability-unverified');
  console.log('History collection disabled; alarm cleared and collection counters unchanged across 35 seconds. Deployed code, other bindings and retained evidence preserved.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await stopHistoryCollection(process.env); } catch {
    console.error('Cloudflare-only stop was not fully verified. Check actual collection health; no automatic re-enable or evidence deletion was attempted. No credentials or raw responses logged.');
    process.exitCode = 1;
  }
}
