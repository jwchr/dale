// One observed GET-only bootstrap in the EXISTING manual main workflow. No pins
// are guessed; this receipt is neither preservation proof nor operation permission.
import { isDeepStrictEqual } from 'node:util';
import { readActiveWorkerIdentity, workerProofError } from './worker-content-identity.mjs';
import { requireEnabledResources, readCanonicalObservation } from './enabled-continuity.mjs';
import { makeRollbackReference, referenceDigest } from './enabled-rollback.mjs';
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
  const receipt = { v: 1, kind: 'enabled-read-only-observation', observerSourceCommit: env.GITHUB_SHA,
    startedAt, observedAt: clock(), pins: { versionId: before.versionId, canonicalContext: observed.context },
    reference, referenceSHA256: referenceDigest(reference), checkpoint: observed.checkpoint,
    actorVersionAttested: false, actorContextHashAttested: false, currentZIPVerified: false,
    rollbackEligibilityVerified: false, operationAuthorized: false };
  if (Buffer.byteLength(JSON.stringify(receipt)) > 8192) throw workerProofError('enabled-qualification-unverified');
  return receipt;
}
