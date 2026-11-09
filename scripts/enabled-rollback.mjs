// Explicit pinned recovery in the existing manual workflow. No automatic fallback,
// resource/settings mutation, secret-force acceptance, NJT call or evidence deletion.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readActiveWorkerIdentity, workerProofError } from './worker-content-identity.mjs';
import { preservationPins, requireEnabledResources, readCanonicalBytes, readPreservedCanonical, readEnabledCheckpoint, preservesEnabled, CODE_DEFERRAL_MS, waitForTransitionProgress } from './enabled-continuity.mjs';
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
export const referenceDigest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const bindings = list => [...list].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const fail = () => { throw workerProofError('enabled-rollback-unverified'); };
/** Non-secret hashes only; no namespace descriptors, secret values, code or transit records. */
export function makeRollbackReference(identity, context) {
  if (!uuid(identity.versionId) || !/^[a-f0-9]{12}:[a-f0-9]{64}$/.test(context)
    || typeof identity.etag !== 'string' || !identity.etag || identity.etag.length > 256 || /[\u0000-\u001f]/.test(identity.etag)) fail();
  requireEnabledResources(identity, { versionId: identity.versionId });
  return { v: 1, versionId: identity.versionId, context, etag: identity.etag,
    contentSHA256: referenceDigest(identity.content), runtimeSHA256: referenceDigest(identity.runtime), bindingsSHA256: referenceDigest(bindings(identity.bindings)) };
}
function readReference(env, pins) {
  const text = env.HISTORY_ROLLBACK_REFERENCE;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4096 || !/^[a-f0-9]{64}$/.test(env.HISTORY_ROLLBACK_REFERENCE_SHA256 ?? '')) fail();
  let reference; try { reference = JSON.parse(text); } catch { fail(); }
  if (!reference || typeof reference !== 'object' || Array.isArray(reference) || referenceDigest(reference) !== env.HISTORY_ROLLBACK_REFERENCE_SHA256 || reference.v !== 1 || !uuid(reference.versionId)
    || reference.versionId === pins.versionId || reference.context !== pins.context
    || typeof reference.etag !== 'string' || !reference.etag || reference.etag.length > 256 || /[\u0000-\u001f]/.test(reference.etag)
    || Object.keys(reference).sort().join() !== ['v', 'versionId', 'context', 'etag', 'contentSHA256', 'runtimeSHA256', 'bindingsSHA256'].sort().join()
    || !['contentSHA256', 'runtimeSHA256', 'bindingsSHA256'].every(k => /^[a-f0-9]{64}$/.test(reference[k]))) fail();
  return reference;
}
export async function rollbackEnabled(env, { net = fetch, clock = Date.now, sleep } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'jwchr/dale'
    || env.HISTORY_COLLECTION_MODE !== 'rollback-enabled' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
    || !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') || !env.CLOUDFLARE_API_TOKEN?.trim()) fail();
  const pins = preservationPins(env), reference = readReference(env, pins);
  const root = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/dale-live`;
  async function api(path, body) {
    const response = await net(root + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000), redirect: 'error', cache: 'no-store' });
    // Includes 10220/secret changes, resource/migration incompatibility, permission,
    // unavailable/expired target and provider refusal. Never retry with force=true.
    if (!response.ok) throw workerProofError('enabled-rollback-refused', response.status);
    const packet = await response.json(); if (packet.success !== true || !packet.result) fail(); return packet.result;
  }
  const current = await readActiveWorkerIdentity(env, { fetchImpl: net });
  requireEnabledResources(current, pins);
  const retained = await readPreservedCanonical(env, { net, clock });
  const deployable = await api('/versions?deployable=true');
  if (!Array.isArray(deployable.items) || deployable.items.length > 100 || !deployable.items.some(v => v.id === reference.versionId)) fail();
  const target = await api('/versions/' + reference.versionId);
  if (target.id !== reference.versionId || target.resources?.script?.etag !== reference.etag
    || !Array.isArray(target.resources?.bindings) || !target.resources?.script_runtime
    || referenceDigest(target.resources.script_runtime) !== reference.runtimeSHA256
    || referenceDigest(bindings(target.resources.bindings)) !== reference.bindingsSHA256
    || referenceDigest(current.runtime) !== reference.runtimeSHA256
    || referenceDigest(bindings(current.bindings)) !== reference.bindingsSHA256) fail();
  requireEnabledResources({ versionId: target.id, bindings: target.resources.bindings }, { versionId: reference.versionId });
  const before = await readPreservedCanonical(env, { net, clock });
  if (before.text !== retained.text) fail(); preservesEnabled(retained.checkpoint, before.checkpoint);
  if (!isDeepStrictEqual(current, await readActiveWorkerIdentity(env, { fetchImpl: net }))) fail();
  // Same single deployment operation as pinned Wrangler4.158 rollback, deliberately
  // without its interactive default confirmation or changed-secret force fallback.
  await api('/deployments', { strategy: 'percentage', versions: [{ version_id: reference.versionId, percentage: 100 }],
    annotations: { 'workers/message': 'Owner-authorized pinned enabled recovery' }, code_update_strategy: { mode: 'deferred', max_delay: CODE_DEFERRAL_MS / 1000 } });
  const acknowledgedAt = clock();
  const afterIdentity = await readActiveWorkerIdentity(env, { fetchImpl: net, expectedVersionId: reference.versionId });
  if (afterIdentity.etag !== reference.etag || referenceDigest(afterIdentity.content) !== reference.contentSHA256
    || referenceDigest(afterIdentity.runtime) !== reference.runtimeSHA256 || referenceDigest(bindings(afterIdentity.bindings)) !== reference.bindingsSHA256) fail();
  const after = await readCanonicalBytes(env, { net, expectedContext: pins.context });
  if (after.text !== before.text) fail();
  const transition = await waitForTransitionProgress(before.checkpoint,
    timeoutMs => readEnabledCheckpoint(env, before.ds.meta.feedVersion, { net, clock, timeoutMs }), acknowledgedAt, { clock, ...(sleep ? { sleep } : {}) });
  const checkpoint = transition.checkpoint;
  if (!isDeepStrictEqual(afterIdentity, await readActiveWorkerIdentity(env, { fetchImpl: net, expectedVersionId: reference.versionId }))) fail();
  return { acknowledgedAt, boundaryAt: transition.boundaryAt, nativeAttemptAt: checkpoint.completedAttempt, archiveSuccessAt: checkpoint.archive.lastSuccessAt, durationMs: checkpoint.at - before.checkpoint.at, interruptionsBefore: before.checkpoint.pendingInterruptionCount,
    interruptionsAfter: checkpoint.pendingInterruptionCount };
}
