import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readActiveWorkerIdentity, workerContentIdentity, workerProofError } from './worker-content-identity.mjs';
export async function verifyUploadedWorker(env, directory, before, options) {
  // Current reviewed bundle has one ESM file; its source map is not uploaded.
  // Any new auxiliary module requires explicit reviewed manifest support.
  const files = readdirSync(directory);
  if (!files.includes('index.js') || files.some(name => !['index.js', 'index.js.map'].includes(name))
    || files.some(name => !lstatSync(join(directory, name)).isFile() || (name === 'index.js' && lstatSync(join(directory, name)).size > 16 * 1024 * 1024))) throw workerProofError('worker-upload-artifact-invalid');
  const form = new FormData();
  form.set('index.js', new Blob([readFileSync(join(directory, 'index.js'))], { type: 'application/javascript+module' }), 'index.js');
  const response = new Response(form); response.headers.set('cf-entrypoint', 'index.js');
  const expected = await workerContentIdentity(response);
  const current = await readActiveWorkerIdentity(env, options);
  const others = bindings => bindings.filter(b => b.name !== 'HISTORY_COLLECTION');
  if (!isDeepStrictEqual(expected, current.content)) throw workerProofError('worker-upload-content-mismatch');
  if (!isDeepStrictEqual(before.runtime, current.runtime)) throw workerProofError('worker-upload-runtime-mismatch');
  if (!isDeepStrictEqual(others(before.bindings), others(current.bindings))) throw workerProofError('worker-upload-bindings-mismatch');
  return current;
}
