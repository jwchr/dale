import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readActiveWorkerIdentity, workerContentIdentity, workerProofError, workerContentComparison } from './worker-content-identity.mjs';
// Statewide raw saving switches (D78; Jeff, Nov 24, 2026: "turn it on"). Each is either absent or the plain variable 'enabled';
// the uploaded Worker must carry exactly what worker/wrangler.jsonc declares, so a deploy can turn one on or off but never change it silently.
export const RAW_SWITCHES = ['RAW_ARCHIVE', 'RAIL_GTFSRT_RAW', 'RAILDATA_RAW', 'BUSDV_RAW', 'TRAFFIC_RAW', 'WEATHER_RAW'];
export const rawSwitchesOk = (bindings, vars) => RAW_SWITCHES.every(name => {
  const found = bindings.filter(b => b.name === name);
  if (vars === undefined) return found.every(b => b.type === 'plain_text' && b.text === 'enabled') && found.length <= 1;
  return vars[name] === undefined ? found.length === 0 : vars[name] === 'enabled' && found.length === 1 && found[0].type === 'plain_text' && found[0].text === 'enabled';
});
// LIVE_GATES is a plain variable, 'off' or 'enabled' (Jeff, Nov 26, 2026: "let's get the gate data into the app asap").
// With `expected`, the binding must be exactly that reviewed config value.
export const gateSwitchOk = (bindings, expected) => {
  const found = bindings.filter(b => b.name === 'LIVE_GATES');
  if (expected !== undefined) return found.length === 1 && found[0].type === 'plain_text' && found[0].text === expected;
  return found.length <= 1 && found.every(b => b.type === 'plain_text' && (b.text === 'off' || b.text === 'enabled'));
};
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
  // The declared mode variables and raw switches are checked by name and value by the caller; every other binding must be unchanged.
  if (!gateSwitchOk(before.bindings) || !gateSwitchOk(current.bindings)) throw workerProofError('worker-upload-bindings-mismatch');
  const others = bindings => bindings.filter(b => b.name !== 'LIVE_GATES' && b.name !== 'HISTORY_COLLECTION' && b.name !== 'ARRIVAL_CONFIDENCE' && !RAW_SWITCHES.includes(b.name));
  if (!isDeepStrictEqual(expected, current.content)) {
    console.error(`Upload module comparison: ${JSON.stringify(workerContentComparison(expected, current.content))}`);
    throw workerProofError('worker-upload-content-mismatch');
  }
  if (!isDeepStrictEqual(before.runtime, current.runtime)) throw workerProofError('worker-upload-runtime-mismatch');
  if (!isDeepStrictEqual(others(before.bindings), others(current.bindings))) throw workerProofError('worker-upload-bindings-mismatch');
  return current;
}
