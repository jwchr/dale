// One observed GET-only bootstrap in the EXISTING manual main workflow. No pins
// are guessed; this receipt is neither preservation proof nor operation permission.
import { isDeepStrictEqual } from 'node:util';
import { readActiveWorkerIdentity, workerProofError } from './worker-content-identity.mjs';
import { requireEnabledResources, readCanonicalObservation } from './enabled-continuity.mjs';
import { makeRollbackReference, referenceDigest } from './enabled-rollback.mjs';
const INVENTORY_TYPES = new Set(['application/javascript+module', 'text/javascript+module', 'application/javascript', 'text/javascript', 'text/x-python', 'text/x-python-requirement', 'application/wasm', 'text/plain', 'application/octet-stream', 'application/source-map']);
export const MAX_QUALIFICATION_RECEIPT_BYTES = 8192;
const fail = () => { throw workerProofError('enabled-qualification-unverified'); };
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && /^[\x20-\x7e]+$/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === keys.sort().join();
/** Complete content/v2 metadata only. No normalization/truncation or raw payload retention. */
export function qualificationInventory(content) {
  if (!exactKeys(content, ['entrypoint', 'modules']) || !identifier(content.entrypoint)
    || !Array.isArray(content.modules) || !content.modules.length || content.modules.length > 128) fail();
  const names = new Set(), filenames = new Set(); let total = 0, previous;
  const modules = content.modules.map(module => {
    if (!exactKeys(module, ['name', 'filename', 'type', 'bytes', 'sha256'])
      || !identifier(module.name) || !identifier(module.filename) || !INVENTORY_TYPES.has(module.type)
      || !Number.isSafeInteger(module.bytes) || module.bytes < 0 || module.bytes > 16 * 1024 * 1024
      || typeof module.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(module.sha256) || names.has(module.name) || filenames.has(module.filename)
      || (previous !== undefined && previous >= module.name)) fail();
    names.add(module.name); filenames.add(module.filename); previous = module.name; total += module.bytes;
    return { name: module.name, filename: module.filename, type: module.type, bytes: module.bytes, sha256: module.sha256 };
  });
  if (total > 16 * 1024 * 1024 || !modules.some(module => (module.name === content.entrypoint || module.filename === content.entrypoint) && module.bytes > 0)) fail();
  return { entrypoint: content.entrypoint, modules };
}
export async function qualifyEnabled(env, { net = fetch, clock = Date.now } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'jwchr/dale'
    || env.HISTORY_COLLECTION_MODE !== 'qualify-enabled' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw workerProofError('enabled-qualification-unverified');
  const startedAt = clock();
  const before = await readActiveWorkerIdentity(env, { fetchImpl: net });
  requireEnabledResources(before, { versionId: before.versionId });
  const observed = await readCanonicalObservation(env, { net, clock });
  const after = await readActiveWorkerIdentity(env, { fetchImpl: net });
  if (!isDeepStrictEqual(before, after)) throw workerProofError('enabled-qualification-unverified');
  const reference = makeRollbackReference(before, observed.context);
  const moduleInventory = qualificationInventory(before.content);
  if (referenceDigest(moduleInventory) !== reference.contentSHA256) fail();
  const receipt = { v: 2, kind: 'enabled-read-only-observation', observerSourceCommit: env.GITHUB_SHA,
    startedAt, observedAt: clock(), pins: { versionId: before.versionId, canonicalContext: observed.context },
    moduleInventory, reference, referenceSHA256: referenceDigest(reference), checkpoint: observed.checkpoint,
    actorVersionAttested: false, actorContextHashAttested: false, currentZIPVerified: false,
    rollbackEligibilityVerified: false, operationAuthorized: false };
  if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_QUALIFICATION_RECEIPT_BYTES) throw workerProofError('enabled-qualification-unverified');
  return receipt;
}
