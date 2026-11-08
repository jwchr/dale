import { workerProofError } from './worker-content-identity.mjs';
// Disabled service health omits archive counters. Unknown is never zero.
export function disabledArchiveEvidence(archive) {
  if (!archive || archive.configured !== true || typeof archive !== 'object' || Array.isArray(archive)) throw workerProofError('disabled-archive-shape-invalid');
  if ('enabled' in archive && archive.enabled !== false) throw workerProofError('disabled-archive-shape-invalid');
  const keys = Object.keys(archive).sort();
  if (archive.enabled === false && keys.length === 2 && keys[0] === 'configured' && keys[1] === 'enabled') return { kind: 'unreported' };
  if (!Number.isSafeInteger(archive.verifiedObjects) || archive.verifiedObjects < 0 || !Number.isSafeInteger(archive.reservedBytes) || archive.reservedBytes < 0) throw workerProofError('disabled-archive-shape-invalid');
  return { kind: 'reported', verifiedObjects: archive.verifiedObjects, reservedBytes: archive.reservedBytes };
}
export function preservesArchiveEvidence(before, after) {
  return before.kind === 'unreported' || (after.kind === 'reported' && after.verifiedObjects >= before.verifiedObjects && after.reservedBytes >= before.reservedBytes);
}
