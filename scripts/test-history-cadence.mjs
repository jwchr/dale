// One explicit protected-main test; expiry is enforced by durable Worker state,
// not this runner's timer. No NJT credential, direct poll or recorder stop.
import { publicCadenceSummary } from '../worker/cadence-summary.ts';
import { waitForReadiness } from './collection-readiness.mjs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { liveApiUrl } from '../src/domain/liveBus.ts';
import { readActiveWorkerIdentity } from './worker-content-identity.mjs';
const FLAG = 'HISTORY_CADENCE_TEST_UNTIL';
export async function testHistoryCadence(env, { fetchImpl = fetch, clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'jwchr/dale') throw new Error('manual-main-required');
  const url = liveApiUrl(env.DALE_WORKER_URL);
  if (!url) throw new Error('configuration-invalid');
  const identity = () => readActiveWorkerIdentity(env, { fetchImpl });
  const health = async (timeoutMs = 15_000) => {
    const response = await fetchImpl(url + '/v1/collection', { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error('health-unavailable');
    return (await response.json()).collection;
  };
  const healthy = s => s?.enabled === true && !s.error && s.scheduleContextStored === true && Number.isSafeInteger(s.alarmAt)
    && s.alarmAt > 0 && s.archive?.reason === 'ready' && s.archive.failures === 0 && s.archive.backlogAgeMs === 0;
  const before = await identity(), first = await health();
  if (!healthy(first) || first.effectiveIntervalMs !== 30000 || first.cadenceTest !== undefined
    || before.bindings.some(b => b.name === FLAG)
    || !before.bindings.some(b => b.name === 'HISTORY_COLLECTION' && b.type === 'plain_text' && b.text === 'enabled')) throw new Error('test-precondition');
  // Capture/check once more immediately before mutation. Never reset an existing lease.
  if (!isDeepStrictEqual(before, await identity())) throw new Error('identity-changed');
  const expiresAt = clock() + 180_000;
  const patch = async active => {
    const form = new FormData();
    form.set('settings', JSON.stringify({ bindings: [...before.bindings.map(b => ({ name: b.name, type: 'inherit' })),
      ...(active ? [{ name: FLAG, type: 'plain_text', text: String(expiresAt) }] : [])] }));
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/dale-live/settings`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, body: form,
      signal: AbortSignal.timeout(20_000), redirect: 'error', cache: 'no-store',
    });
    if (!response.ok || (await response.json()).success !== true) throw new Error('test-setting-unverified');
  };
  await patch(true);
  const active = await identity();
  const expected = [...before.bindings, { name: FLAG, type: 'plain_text', text: String(expiresAt) }].sort((a,b)=>a.name.localeCompare(b.name));
  if (!isDeepStrictEqual(active.content, before.content) || !isDeepStrictEqual(active.runtime, before.runtime)
    || !isDeepStrictEqual(active.bindings, expected)) throw new Error('test-preservation-unverified');
  const running = await health();
  if (!healthy(running) || running.effectiveIntervalMs !== 5000 || running.cadenceTest?.expiresAt !== expiresAt) throw new Error('test-activation-unverified');
  console.log('One-shot test active: five-second pacing; absolute expiry within three minutes; at most36 attempts. Regular pacing remains30seconds.');
  await sleep(Math.max(0, expiresAt + 1000 - clock()));
  const ended = await waitForReadiness(async timeoutMs => {
    const state = await health(timeoutMs);
    return healthy(state) && !state.incompleteAttempt && state.effectiveIntervalMs === 30000
      && state.cadenceTest?.expiresAt === expiresAt ? state : undefined;
  }, { clock, sleep });
  if (!healthy(ended) || ended.effectiveIntervalMs !== 30000 || ended.cadenceTest?.expiresAt !== expiresAt
    || !Number.isSafeInteger(ended.cadenceTest.attempts) || ended.cadenceTest.attempts < 0 || ended.cadenceTest.attempts > 36) throw new Error('test-expiry-unverified');
  const summary = publicCadenceSummary(ended.cadenceTest.summary);
  if (summary.polls > 36 || summary.upstreamVehicleAttempts > summary.polls) throw new Error('test-summary-invalid');
  // Remove only the temporary binding after automatic expiry. Durable consumed
  // state remains: runner retries cannot renew or repeat this one authorized test.
  const current = await identity();
  if (!isDeepStrictEqual(current, active)) throw new Error('identity-changed');
  await patch(false);
  const restored = await identity();
  if (!isDeepStrictEqual(restored.content, before.content) || !isDeepStrictEqual(restored.runtime, before.runtime)
    || !isDeepStrictEqual(restored.bindings, before.bindings)) throw new Error('test-cleanup-unverified');
  const final = await health();
  if (!healthy(final) || final.effectiveIntervalMs !== 30000 || final.cadenceTest?.expiresAt !== expiresAt) throw new Error('test-final-unverified');
  console.log('Bounded sample aggregate: ' + JSON.stringify(summary));
  console.log(`Test expired automatically; recording remains ON at30seconds. Accelerated attempts: ${ended.cadenceTest.attempts}. No lasting rate adjustment authorized. Analyze private archived source clocks separately.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await testHistoryCadence(process.env); }
  catch { console.error('Bounded cadence test not fully verified. Inspect actual read-only health; no retry, extension, stop or permanent rate change attempted. Raw responses and credentials omitted.'); process.exitCode = 1; }
}
