import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readActiveWorkerIdentity, workerContentIdentity, workerProofError, workerContentComparison } from './worker-content-identity.mjs';
export async function verifyUploadedWorker(env, directory, before, options) {
  // Current reviewed bundle has one ESM file; its source map and pinned Wrangler README are not uploaded.
  // Any new auxiliary module requires explicit reviewed manifest support.
  const files = readdirSync(directory);
  if (!files.includes('index.js') || files.some(name => !['index.js', 'index.js.map', 'README.md'].includes(name))
    || files.some(name => !lstatSync(join(directory, name)).isFile() || (name === 'index.js' && lstatSync(join(directory, name)).size > 16 * 1024 * 1024))) throw workerProofError('worker-upload-artifact-invalid');
  if (files.includes('README.md')) {
    const readme = join(directory, 'README.md');
    if (lstatSync(readme).size > 512 || !/^This folder contains the built output assets for the worker "dale-live" generated at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.$/.test(readFileSync(readme, 'utf8'))) throw workerProofError('worker-upload-artifact-invalid');
  }
  const form = new FormData();
  form.set('index.js', new Blob([readFileSync(join(directory, 'index.js'))], { type: 'application/javascript+module' }), 'index.js');
  const response = new Response(form); response.headers.set('cf-entrypoint', 'index.js');
  const expected = await workerContentIdentity(response);
  const current = await readActiveWorkerIdentity(env, options);
  const others = bindings => bindings.filter(b => b.name !== 'HISTORY_COLLECTION');
  if (!isDeepStrictEqual(expected, current.content)) {
    console.error(`Upload module comparison: ${JSON.stringify(workerContentComparison(expected, current.content))}`);
    throw workerProofError('worker-upload-content-mismatch');
  }
  if (!isDeepStrictEqual(before.runtime, current.runtime)) throw workerProofError('worker-upload-runtime-mismatch');
  if (!isDeepStrictEqual(others(before.bindings), others(current.bindings))) throw workerProofError('worker-upload-bindings-mismatch');
  return current;
}
