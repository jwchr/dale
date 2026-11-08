// One explicit protected-main test; expiry is enforced by durable Worker state,
// not this runner's timer. No NJT credential, direct poll or recorder stop.
import { publicCadenceSummary } from '../worker/cadence-summary.ts';
import { waitForReadiness } from './collection-readiness.mjs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { liveApiUrl } from '../src/domain/liveBus.ts';
import { readActiveWorkerIdentity, workerProofDiagnostic } from './worker-content-identity.mjs';
const FLAG = 'HISTORY_CADENCE_TEST_UNTIL';
const CONTROL_REASONS = new Set(["cleanup-evidence-unverified", "cleanup-precondition", "cleanup-preservation-unverified", "cleanup-setting-unverified", "configuration-invalid", "health-unavailable", "identity-changed", "manual-main-required", "test-activation-unverified", "test-adoption-unverified", "test-cleanup-unverified", "test-expiry-unverified", "test-final-unverified", "test-precondition", "test-preservation-unverified", "test-setting-unverified", "test-summary-invalid"]);
class CadenceFailure extends Error { constructor(reason) { super('bounded-cadence-control-failed'); this.reason = CONTROL_REASONS.has(reason) ? reason : 'unexpected-failure'; } }
const failure = reason => new CadenceFailure(reason);
export function safeCadenceFailure(error) {
  const proof = workerProofDiagnostic(error);
  return error instanceof CadenceFailure && CONTROL_REASONS.has(error.reason) ? error.reason : proof ? proof.reason : ['TimeoutError','AbortError'].includes(error?.name) ? 'request-timeout' : 'unexpected-failure';
}

export async function testHistoryCadence(env, { fetchImpl = fetch, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'jwchr/dale') throw failure('manual-main-required');
  const url = liveApiUrl(env.DALE_WORKER_URL);
  if (!url) throw failure('configuration-invalid');
  const identity = () => readActiveWorkerIdentity(env, { fetchImpl });
  const health = async (timeoutMs = 15_000) => {
    const response = await fetchImpl(url + '/v1/collection', { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw failure('health-unavailable');
    return (await response.json()).collection;
  };
  const healthy = s => s?.enabled === true && !s.error && s.scheduleContextStored === true && Number.isSafeInteger(s.alarmAt)
    && s.alarmAt > 0 && s.archive?.reason === 'ready' && s.archive.failures === 0 && s.archive.backlogAgeMs === 0;
  const before = await identity(), first = await health();
  if (!healthy(first) || !Number.isSafeInteger(first.pendingInterruptionCount) || first.pendingInterruptionCount < 0 || first.effectiveIntervalMs !== 30000 || first.cadenceTest !== undefined
    || before.bindings.some(b => b.name === FLAG)
    || !before.bindings.some(b => b.name === 'HISTORY_COLLECTION' && b.type === 'plain_text' && b.text === 'enabled')) throw failure('test-precondition');
  // Capture/check once more immediately before mutation. Never reset an existing lease.
  if (!isDeepStrictEqual(before, await identity())) throw failure('identity-changed');
  const expiresAt = clock() + 180_000;
  const patch = async active => {
    const form = new FormData();
    form.set('settings', JSON.stringify({ bindings: [...before.bindings.map(b => ({ name: b.name, type: 'inherit' })),
      ...(active ? [{ name: FLAG, type: 'plain_text', text: String(expiresAt) }] : [])] }));
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/dale-live/settings`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, body: form,
      signal: AbortSignal.timeout(20_000), redirect: 'error', cache: 'no-store',
    });
    if (!response.ok || (await response.json()).success !== true) throw failure('test-setting-unverified');
  };
  await patch(true);
  const expected = [...before.bindings, { name: FLAG, type: 'plain_text', text: String(expiresAt) }].sort((a,b)=>a.name.localeCompare(b.name));
  let adoptionVersion;
  const activated = await waitForReadiness(async timeoutMs => {
    const current = await readActiveWorkerIdentity(env, { fetchImpl: (input, options) => {
      const remaining = expiresAt - clock();
      if (remaining <= 0) throw failure('test-activation-unverified');
      return fetchImpl(input, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining)))]) });
    } });
    if (!isDeepStrictEqual(current.content, before.content) || !isDeepStrictEqual(current.runtime, before.runtime)) throw failure('test-preservation-unverified');
    // An unchanged old binding view is propagation, never proof of activation.
    if (isDeepStrictEqual(current.bindings, before.bindings)) return undefined;
    if (!isDeepStrictEqual(current.bindings, expected)) throw failure('test-preservation-unverified');
    if (adoptionVersion && current.versionId !== adoptionVersion) throw failure('identity-changed');
    if (!adoptionVersion) {
      const observed = await health(Math.min(timeoutMs, Math.max(1, expiresAt - clock())));
      if (healthy(observed) && observed.effectiveIntervalMs === 5000 && observed.cadenceTest?.expiresAt === expiresAt) return current;
      // Never intentionally reset a known in-flight poll/archive. This snapshot
      // cannot make the cross-control-plane transition atomic; journal/R2 crash
      // recovery remains required if a platform reset interrupts work.
      if (!healthy(observed) || observed.incompleteAttempt !== false) return undefined;
      // Settings versions may defer a warm object's constructor for five minutes.
      // Adopt this exact verified version immediately; never upload or select a draft.
      if (!isDeepStrictEqual(current, await identity())) throw failure('identity-changed');
      adoptionVersion = current.versionId;
      const remaining = expiresAt - clock();
      if (remaining <= 0) throw failure('test-activation-unverified');
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/dale-live/deployments`, {
        method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: 'percentage', versions: [{ version_id: adoptionVersion, percentage: 100 }], code_update_strategy: { mode: 'immediate' } }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, remaining))), redirect: 'error', cache: 'no-store',
      });
      if (!response.ok || (await response.json()).success !== true) throw failure('test-adoption-unverified');
      return undefined; // Require fresh identity/actor evidence after adoption.
    }
    const running = await health(Math.min(timeoutMs, Math.max(1, expiresAt - clock())));
    return healthy(running) && running.effectiveIntervalMs === 5000 && running.cadenceTest?.expiresAt === expiresAt
      ? current : undefined;
  }, { clock, sleep, timeoutMs: Math.max(1, expiresAt - clock()) });
  if (!activated) throw failure('test-activation-unverified');
  const active = activated;
  console.log('One-shot test active: five-second pacing; absolute expiry within three minutes; at most36 attempts. Regular pacing remains30seconds.');
  await sleep(Math.max(0, expiresAt + 1000 - clock()));
  const ended = await waitForReadiness(async timeoutMs => {
    const state = await health(timeoutMs);
    return healthy(state) && !state.incompleteAttempt && state.pendingInterruptionCount === 0 && state.effectiveIntervalMs === 30000
      && state.cadenceTest?.expiresAt === expiresAt ? state : undefined;
  }, { clock, sleep });
  if (!healthy(ended) || ended.effectiveIntervalMs !== 30000 || ended.cadenceTest?.expiresAt !== expiresAt
    || !Number.isSafeInteger(ended.cadenceTest.attempts) || ended.cadenceTest.attempts < 0 || ended.cadenceTest.attempts > 36) throw failure('test-expiry-unverified');
  const summary = publicCadenceSummary(ended.cadenceTest.summary);
  if (summary.polls > 36 || summary.upstreamVehicleAttempts > summary.polls) throw failure('test-summary-invalid');
  // Remove only the temporary binding after automatic expiry. Durable consumed
  // state remains: runner retries cannot renew or repeat this one authorized test.
  const current = await identity();
  if (!isDeepStrictEqual(current, active)) throw failure('identity-changed');
  await patch(false);
  const restored = await identity();
  if (!isDeepStrictEqual(restored.content, before.content) || !isDeepStrictEqual(restored.runtime, before.runtime)
    || !isDeepStrictEqual(restored.bindings, before.bindings)) throw failure('test-cleanup-unverified');
  const final = await health();
  if (!healthy(final) || final.effectiveIntervalMs !== 30000 || final.cadenceTest?.expiresAt !== expiresAt) throw failure('test-final-unverified');
  console.log('Bounded sample aggregate: ' + JSON.stringify(summary));
  console.log(`Test expired automatically; recording remains ON at30seconds. Accelerated attempts: ${ended.cadenceTest.attempts}. No lasting rate adjustment authorized. Analyze private archived source clocks separately.`);
}
export async function cleanupExpiredCadenceFlag(env, { fetchImpl = fetch, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'jwchr/dale') throw failure('manual-main-required');
  const url = liveApiUrl(env.DALE_WORKER_URL);
  if (!url) throw failure('configuration-invalid');
  const identity = () => readActiveWorkerIdentity(env, { fetchImpl });
  const health = async () => {
    const response = await fetchImpl(url + '/v1/collection', { signal: AbortSignal.timeout(15_000), redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw failure('health-unavailable');
    return (await response.json()).collection;
  };
  const before = await identity(), first = await health(), flags = before.bindings.filter(b => b.name === FLAG);
  if (flags.length !== 1 || flags[0].type !== 'plain_text' || !/^[0-9]{13}$/.test(flags[0].text)
    || Number(flags[0].text) > clock() || first?.enabled !== true || first.error || first.effectiveIntervalMs !== 30000
    || !Number.isSafeInteger(first.alarmAt) || first.alarmAt <= 0 || first.scheduleContextStored !== true
    || !Number.isSafeInteger(first.observations) || first.observations < 0 || !Number.isSafeInteger(first.batches) || first.batches < 0
    || !before.bindings.some(b=>b.name==='HISTORY_COLLECTION' && b.type==='plain_text' && b.text==='enabled')) throw failure('cleanup-precondition');
  const expected = before.bindings.filter(b => b.name !== FLAG);
  if (!isDeepStrictEqual(before, await identity())) throw failure('identity-changed');
  const form = new FormData();form.set('settings', JSON.stringify({bindings: expected.map(b=>({name:b.name,type:'inherit'}))}));
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/dale-live/settings`, {
    method:'PATCH', headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`},body:form,signal:AbortSignal.timeout(20_000),redirect:'error',cache:'no-store',
  });
  if (!response.ok || (await response.json()).success !== true) throw failure('cleanup-setting-unverified');
  const restored = await waitForReadiness(async()=>{
    const current = await identity();
    if (!isDeepStrictEqual(current.content,before.content) || !isDeepStrictEqual(current.runtime,before.runtime)) throw failure('cleanup-preservation-unverified');
    if (isDeepStrictEqual(current.bindings,expected)) return current;
    if (isDeepStrictEqual(current.bindings,before.bindings)) return undefined;
    throw failure('cleanup-preservation-unverified');
  },{clock,sleep});
  if (!restored) throw failure('cleanup-preservation-unverified');
  const final = await health();
  if (final?.enabled !== true || final.error || final.effectiveIntervalMs !== 30000 || !Number.isSafeInteger(final.alarmAt) || final.alarmAt <= 0
    || final.scheduleContextStored !== true || !isDeepStrictEqual(final.cadenceTest,first.cadenceTest)
    || !Number.isSafeInteger(final.observations) || final.observations < first.observations
    || !Number.isSafeInteger(final.batches) || final.batches < first.batches) throw failure('cleanup-evidence-unverified');
  console.log('Only the expired cadence binding removed; complete code/runtime/other bindings preserved. Recording remains ON at30seconds; consumed journal state unchanged. No activation attempted.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--cleanup-expired')) throw failure('configuration-invalid');
    if (process.argv[2] === '--cleanup-expired') await cleanupExpiredCadenceFlag(process.env);
    else await testHistoryCadence(process.env);
  }
  catch (error) { console.error('Cadence diagnostic: reason=' + safeCadenceFailure(error) + '.'); console.error('Bounded cadence control not fully verified. Inspect actual read-only health; no retry, extension, stop or permanent rate change attempted. Raw responses and credentials omitted.'); process.exitCode = 1; }
}
