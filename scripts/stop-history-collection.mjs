// Authenticated settings-only stop: no script upload, schedule preparation or NJT call.
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { liveApiUrl } from '../src/domain/liveBus.ts';
import { readActiveWorkerIdentity, workerProofDiagnostic } from './worker-content-identity.mjs';
// Only locally constructed, closed diagnostics may reach public Actions logs.
class StopFailure extends Error {
  constructor(reason, stage, status) { super(reason); this.reason = reason; this.stage = stage; this.status = status; }
}
export function safeStopFailure(error) {
  const stages = ['authorization', 'configuration', 'read-deployments', 'read-versions', 'read-version', 'read-settings', 'settings-patch', 'verify-active-version', 'verify-binding-state', 'verify-preservation', 'verify-disabled-health', 'verify-stability', 'inspect-original-transition', 'capture-before-content', 'capture-after-content'];
  const reasons = ['manual-main-required', 'stop-configuration-invalid', 'cloudflare-stop-request-failed', 'cloudflare-stop-response-invalid', 'stop-active-version-ambiguous', 'stop-binding-state-invalid', 'stop-version-changed', 'stop-other-bindings-changed', 'stop-disabled-setting-unverified', 'stop-code-changed', 'stop-runtime-changed', 'stop-health-unavailable', 'stop-health-invalid', 'stop-disabled-unverified', 'stop-stability-unverified', 'invalid-json', 'request-timeout', 'unexpected-failure', 'stop-original-transition-unavailable', 'stop-original-preservation-unverified', 'stop-module-content-changed', 'worker-content-unavailable', 'worker-content-invalid', 'worker-content-limit', 'worker-identity-configuration', 'worker-identity-request-failed', 'worker-identity-response-invalid', 'worker-identity-version-ambiguous', 'worker-identity-metadata-invalid', 'worker-identity-state-changed', 'worker-content-entrypoint-invalid', 'worker-content-type-unsupported', 'worker-content-duplicate'];
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
    stage = 'capture-before-content';
    const before = await readActiveWorkerIdentity(env, { fetchImpl });
    const beforeId = before.versionId;
    const bindings = before.bindings;
    const others = list => list.filter(b => b.name !== 'HISTORY_COLLECTION').sort((a,b) => a.name.localeCompare(b.name));
    if (await active() !== beforeId) throw failure('stop-version-changed');
    const form = new FormData();
    form.set('settings', JSON.stringify({ bindings: [...others(bindings).map(b => ({ name: b.name, type: 'inherit' })), { name: 'HISTORY_COLLECTION', type: 'plain_text', text: 'disabled' }] }));
    await api('/settings', form);
    stage = 'capture-after-content';
    const after = await readActiveWorkerIdentity(env, { fetchImpl });
    stage = 'verify-preservation';
    if (!isDeepStrictEqual(others(bindings), others(after.bindings))) throw failure('stop-other-bindings-changed');
    if (after.bindings.filter(b => b.name === 'HISTORY_COLLECTION').length !== 1 || !after.bindings.some(b => b.name === 'HISTORY_COLLECTION' && b.type === 'plain_text' && b.text === 'disabled')) throw failure('stop-disabled-setting-unverified');
    // ETags are retained as metadata, but executable identity requires the stronger
    // exact complete module proof. No byte normalization or missing-module waiver.
    if (!isDeepStrictEqual(after.content, before.content)) throw failure('stop-module-content-changed');
    if (!isDeepStrictEqual(after.runtime, before.runtime)) throw failure('stop-runtime-changed');
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
    console.log(`Stop code proof: completeModulesEqual=true metadataEtagEqual=${before.etag === after.etag}.`);
    console.log('History collection disabled; alarm cleared and collection counters unchanged across 35 seconds. Deployed code, other bindings and retained evidence preserved.');
  } catch (error) {
    if (error instanceof StopFailure) throw error;
    const proof = workerProofDiagnostic(error);
    if (proof) throw failure(proof.reason, proof.status);
    // Never forward exception messages, response bodies, URLs, identifiers or stacks.
    throw failure(error instanceof SyntaxError ? 'invalid-json' : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'request-timeout' : 'unexpected-failure');
  }
}
// Inspect the original adjacent enabled -> disabled versions BEFORE any idempotent
// stop retry. This function has no mutation path and never prints version identities.
export async function inspectHistoryStop(env, { fetchImpl = fetch } = {}) {
  let stage = 'authorization';
  const failure = (reason, status) => new StopFailure(reason, stage, status);
  try {
    if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'jwchr/dale') throw failure('manual-main-required');
    stage = 'configuration';
    if (!liveApiUrl(env.DALE_WORKER_URL) || !env.CLOUDFLARE_API_TOKEN?.trim() || !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) throw failure('stop-configuration-invalid');
    const root = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/dale-live`;
    async function get(path) {
      stage = path === '/deployments' ? 'read-deployments' : path === '/versions' ? 'read-versions' : 'read-version';
      const response = await fetchImpl(root + path, { method: 'GET', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(20_000), redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw failure('cloudflare-stop-request-failed', Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined);
      const packet = await response.json();
      if (packet.success !== true || !packet.result) throw failure('cloudflare-stop-response-invalid');
      return packet.result;
    }
    const deployment = (await get('/deployments')).deployments?.[0];
    const versions = (await get('/versions')).items;
    stage = 'inspect-original-transition';
    if (!Array.isArray(versions) || !versions[0]?.id || !versions[1]?.id || versions[0].id === versions[1].id || deployment?.versions?.length !== 1 || deployment.versions[0].percentage !== 100 || deployment.versions[0].version_id !== versions[0].id) throw failure('stop-original-transition-unavailable');
    const current = await get(`/versions/${encodeURIComponent(versions[0].id)}`);
    const previous = await get(`/versions/${encodeURIComponent(versions[1].id)}`);
    // Recheck both identities and serving state; another control-plane writer must
    // remain paused. No atomic cross-request snapshot is claimed.
    const finalDeployment = (await get('/deployments')).deployments?.[0];
    const finalVersions = (await get('/versions')).items;
    stage = 'inspect-original-transition';
    const validBindings = resource => Array.isArray(resource?.bindings) && resource.bindings.every(b => typeof b.name === 'string' && b.name && typeof b.type === 'string') && new Set(resource.bindings.map(b => b.name)).size === resource.bindings.length;
    const flag = resource => resource.bindings.filter(b => b.name === 'HISTORY_COLLECTION');
    const a = previous.resources, b = current.resources;
    if (finalVersions?.[0]?.id !== versions[0].id || finalVersions?.[1]?.id !== versions[1].id || !isDeepStrictEqual(finalDeployment?.versions, deployment.versions) || !validBindings(a) || !validBindings(b) || !a.script?.etag || !b.script?.etag || !a.script_runtime || !b.script_runtime || flag(a).length !== 1 || flag(b).length !== 1 || flag(a)[0].type !== 'plain_text' || flag(b)[0].type !== 'plain_text' || flag(a)[0].text !== 'enabled' || flag(b)[0].text !== 'disabled') throw failure('stop-original-transition-unavailable');
    const others = resource => resource.bindings.filter(binding => binding.name !== 'HISTORY_COLLECTION').sort((x,y) => x.name.localeCompare(y.name));
    const codeEqual = a.script.etag === b.script.etag;
    const runtimeEqual = isDeepStrictEqual(a.script_runtime, b.script_runtime);
    const bindingsEqual = isDeepStrictEqual(others(a), others(b));
    console.log(`Original adjacent stop comparison: codeEqual=${codeEqual} runtimeEqual=${runtimeEqual} bindingsEqual=${bindingsEqual} enabledToDisabled=true activeLatest=true.`);
    if (!codeEqual || !runtimeEqual || !bindingsEqual) throw failure('stop-original-preservation-unverified');
  } catch (error) {
    if (error instanceof StopFailure) throw error;
    const proof = workerProofDiagnostic(error);
    if (proof) throw failure(proof.reason, proof.status);
    throw failure(error instanceof SyntaxError ? 'invalid-json' : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'request-timeout' : 'unexpected-failure');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--inspect')) throw new StopFailure('stop-configuration-invalid', 'configuration');
    if (process.argv[2] === '--inspect') await inspectHistoryStop(process.env);
    else await stopHistoryCollection(process.env);
  } catch (error) {
    console.error(`Stop diagnostic: ${safeStopFailure(error)}.`);
    console.error(process.argv[2] === '--inspect'
      ? 'Read-only original stop inspection failed. No setting mutation, resume or evidence deletion was attempted. No credentials or raw responses logged.'
      : 'Cloudflare-only stop was not fully verified. Check actual collection health; no automatic re-enable or evidence deletion was attempted. No credentials or raw responses logged.');
    process.exitCode = 1;
  }
}
