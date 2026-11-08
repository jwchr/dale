import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

// Deployment runs unbundled Node ESM, unlike Vite/Vitest. Load the real entry points in a
// separate Node process with no inherited credentials or main-workflow authorization.
// The fetch trap makes this an offline import/preflight check, never a deployment attempt.
it.each([
  ['prepare-live-worker.mjs', 'Official G2 corridor preparation failed at preflight. No credentials, token or response details are logged. Do not deploy.'],
  ['deploy-live-worker.mjs', 'Live Worker deployment or validation failed. Do not infer collection is inactive: verify its actual health/stop state. No raw error or secret values are logged. Check the private hosting setup.'],
])('%s loads in native Node and stops at its authorization guard', (entry, message) => {
  const url = new URL(`../../scripts/${entry}`, import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    globalThis.fetch = () => { process.stderr.write('Unexpected network request'); process.exit(99); };
    await import(${JSON.stringify(url)});
  `], { env: { NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toBe(entry === 'deploy-live-worker.mjs' ? 'Worker proof diagnostic: reason=manual-main-required.\n' + message : message);
});
