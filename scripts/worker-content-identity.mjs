// Private, bounded content/v2 proof. Never writes or logs downloaded module bytes.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const PROOF_REASONS = ['enabled-qualification-unverified', 'enabled-rollback-unverified', 'enabled-rollback-refused', 'enabled-continuity-unverified', 'worker-content-unavailable', 'worker-content-invalid', 'worker-content-limit', 'worker-identity-configuration', 'worker-identity-request-failed', 'worker-identity-response-invalid', 'worker-identity-version-ambiguous', 'worker-identity-metadata-invalid', 'worker-identity-state-changed', 'worker-upload-artifact-invalid', 'worker-upload-proof-failed', 'worker-content-entrypoint-invalid', 'worker-content-type-unsupported', 'worker-content-duplicate', 'worker-upload-content-mismatch', 'worker-upload-runtime-mismatch', 'worker-upload-bindings-mismatch', 'worker-existing-configuration-mismatch', 'manual-main-required', 'collection-mode-invalid', 'configuration-invalid', 'reviewed-source-identity-required', 'existing-resource-identity-required', 'restore-disabled-precondition', 'deployment-failed', 'uploaded-mode-invalid', 'health-check-failed', 'restored-evidence-unverified', 'live-check-failed', 'invalid-profile', 'collection-health-failed', 'archive-readback-unverified', 'collection-state-unverified', 'exact-bus-check-failed', 'schedule-preflight-failed', 'hosting-config-preflight-failed', 'disabled-archive-shape-invalid', 'rollover-receipt-unverified', 'rollover-schedule-invalid', 'rollover-capacity-refused', 'rollover-schedule-not-served', 'rollover-context-admission-failed', 'rollover-progress-unverified'];
class WorkerProofError extends Error {
  constructor(reason, status) { super(reason); this.reason = reason; this.status = status; }
}
export function workerProofError(reason, status) {
  return new WorkerProofError(PROOF_REASONS.includes(reason) ? reason : 'worker-content-invalid', status);
}
export function workerProofDiagnostic(error) {
  if (!(error instanceof WorkerProofError) || !PROOF_REASONS.includes(error.reason)) return undefined;
  return { reason: error.reason, status: Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : undefined };
}
const MAX_BYTES = 16 * 1024 * 1024;
export async function workerContentIdentity(response) {
  if (!response.ok || !response.body) throw workerProofError('worker-content-unavailable');
  const contentType = response.headers.get('content-type') ?? '';
  const entrypoint = response.headers.get('cf-entrypoint');
  if (!/^multipart\/form-data;/i.test(contentType)) throw workerProofError('worker-content-invalid');
  if (!entrypoint || entrypoint.length > 1024) throw workerProofError('worker-content-entrypoint-invalid');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw workerProofError('worker-content-limit');
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BYTES) throw workerProofError('worker-content-limit');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  // Fetch decodes HTTP compression before exposing module bytes; a compressed
  // transport Content-Length does not describe that decoded body.
  const encoding = response.headers.get('content-encoding');
  if (encoding && !['identity', 'gzip', 'br', 'deflate'].includes(encoding)) throw workerProofError('worker-content-invalid');
  if ((!encoding || encoding === 'identity') && declared !== null && Number(declared) !== bytes) throw workerProofError('worker-content-invalid');
  // Parse only the bounded transport framing. Response.formData() would decode
  // filename-less parts as UTF-8 strings and can collapse distinct binary bytes.
  const boundary = /^multipart\/form-data;\s*boundary=(?:"([0-9A-Za-z'()+_,.\/:=?-]{1,70})"|([0-9A-Za-z'()+_,.\/:=?-]{1,70}))$/i.exec(contentType);
  if (!boundary) throw workerProofError('worker-content-invalid');
  const body = Buffer.concat(chunks);
  const marker = Buffer.from('--' + (boundary[1] || boundary[2]));
  const delimiter = Buffer.concat([Buffer.from('\r\n'), marker]);
  if (!body.subarray(0, marker.length + 2).equals(Buffer.concat([marker, Buffer.from('\r\n')]))) throw workerProofError('worker-content-invalid');
  let offset = marker.length + 2;
  const modules = [], names = new Set(), filenames = new Set();
  const knownTypes = ['application/javascript+module', 'text/javascript+module', 'application/javascript', 'text/javascript', 'text/x-python', 'text/x-python-requirement', 'application/wasm', 'text/plain', 'application/octet-stream', 'application/source-map'];
  while (true) {
    const endHeaders = body.indexOf('\r\n\r\n', offset);
    if (endHeaders < 0 || endHeaders - offset > 16384 || modules.length >= 128) throw workerProofError('worker-content-invalid');
    const headers = new Map();
    for (const line of body.subarray(offset, endHeaders).toString('latin1').split('\r\n')) {
      const match = /^([A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
      if (!match || headers.has(match[1].toLowerCase()) || !['content-disposition', 'content-type'].includes(match[1].toLowerCase())) throw workerProofError('worker-content-invalid');
      headers.set(match[1].toLowerCase(), match[2]);
    }
    const disposition = /^form-data; name="([^"\r\n]{1,1024})"(?:; filename="([^"\r\n]{1,1024})")?$/.exec(headers.get('content-disposition') ?? '');
    if (!disposition || /[^\x20-\x7e]/.test(disposition[0])) throw workerProofError('worker-content-invalid');
    const name = disposition[1], filename = disposition[2] ?? name;
    const type = headers.get('content-type') ?? 'text/plain';
    if (!knownTypes.includes(type)) throw workerProofError('worker-content-type-unsupported');
    if (names.has(name) || filenames.has(filename)) throw workerProofError('worker-content-duplicate');
    names.add(name); filenames.add(filename);
    const start = endHeaders + 4;
    let end = body.indexOf(delimiter, start);
    // A boundary-looking sequence inside a binary module is ordinary payload
    // unless followed by a legal delimiter suffix.
    while (end >= 0 && !['--', '\r\n'].includes(body.subarray(end + delimiter.length, end + delimiter.length + 2).toString('latin1'))) end = body.indexOf(delimiter, end + 1);
    if (end < 0) throw workerProofError('worker-content-invalid');
    const payload = body.subarray(start, end);
    modules.push({ name, filename, type, bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') });
    offset = end + delimiter.length;
    if (body.subarray(offset, offset + 2).toString('latin1') === '--') {
      const tail = body.subarray(offset + 2).toString('latin1');
      if (tail !== '' && tail !== '\r\n') throw workerProofError('worker-content-invalid');
      break;
    }
    offset += 2;
  }
  if (!modules.length || !modules.some(m => (m.name === entrypoint || m.filename === entrypoint) && m.bytes > 0)) throw workerProofError('worker-content-invalid');
  modules.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { entrypoint, modules };
}

// Script-scoped content is bound ONLY to the bracketed ACTIVE version. Latest is
// required by default; an explicit UUID pin permits a previously published rollback target.
// It is never a historical version download or permission to infer old code bytes.
export async function readActiveWorkerIdentity(env, { fetchImpl = fetch, expectedVersionId } = {}) {
  if (expectedVersionId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(expectedVersionId)) throw workerProofError('worker-identity-configuration');
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'jwchr/dale'
    || !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') || !env.CLOUDFLARE_API_TOKEN?.trim()) throw workerProofError('worker-identity-configuration');
  const root = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/dale-live`;
  async function request(path) {
    const response = await fetchImpl(root + path, { method: 'GET', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, Accept: 'string' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw workerProofError('worker-identity-request-failed', response.status);
    return response;
  }
  async function api(path) {
    const packet = await (await request(path)).json();
    if (packet.success !== true || !packet.result) throw workerProofError('worker-identity-response-invalid');
    return packet.result;
  }
  async function active() {
    const deployment = (await api('/deployments')).deployments?.[0];
    const latest = (await api('/versions')).items?.[0]?.id;
    if (typeof latest !== 'string' || !latest || deployment?.versions?.length !== 1 || deployment.versions[0].percentage !== 100 || (expectedVersionId === undefined ? deployment.versions[0].version_id !== latest : deployment.versions[0].version_id !== expectedVersionId)) throw workerProofError('worker-identity-version-ambiguous');
    return deployment.versions[0].version_id;
  }
  const versionId = await active();
  const version = await api(`/versions/${encodeURIComponent(versionId)}`);
  const settings = await api('/settings');
  if (version.id !== versionId || !version.resources?.script?.etag || !version.resources.script_runtime || !Array.isArray(settings.bindings)
    || settings.bindings.some(b => typeof b.name !== 'string' || !b.name || typeof b.type !== 'string') || new Set(settings.bindings.map(b => b.name)).size !== settings.bindings.length) throw workerProofError('worker-identity-metadata-invalid');
  const content = await workerContentIdentity(await request('/content/v2'));
  const finalVersionId = await active();
  const finalSettings = await api('/settings');
  const sorted = bindings => [...bindings].sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  // isDeepStrictEqual preserves every descriptor field, including namespace/bucket.
  if (finalVersionId !== versionId || !Array.isArray(finalSettings.bindings) || !isDeepStrictEqual(sorted(settings.bindings), sorted(finalSettings.bindings))) throw workerProofError('worker-identity-state-changed');
  return { versionId, content, etag: version.resources.script.etag, runtime: version.resources.script_runtime, bindings: sorted(settings.bindings) };
}

// Fixed field classes only: never expose module identifiers, types, lengths or hashes.
// Diagnostics do not change full-manifest equality or establish historical identity.
export function workerContentComparison(before, after) {
  const equal = field => isDeepStrictEqual(before.modules.map(m => m[field]), after.modules.map(m => m[field]));
  return { entrypointEqual: before.entrypoint === after.entrypoint,
    moduleCountEqual: before.modules.length === after.modules.length,
    namesEqual: equal('name'), filenamesEqual: equal('filename'), typesEqual: equal('type'),
    lengthsEqual: equal('bytes'), byteDigestsEqual: equal('sha256') };
}
