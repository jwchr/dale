import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
let child: ChildProcess | undefined, base: string, directory: string;
beforeAll(async () => {
  const probe = createServer();
  const port = await new Promise<number>(resolve => probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port)));
  await new Promise<void>(resolve => probe.close(() => resolve()));
  directory = await mkdtemp(join(tmpdir(), 'dale-history-runtime-'));
  const fixture = spawn(process.execPath, ['scripts/worker-fixture.mjs'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { fixture.once('error', reject); fixture.once('exit', n => n === 0 ? resolve() : reject(new Error('Synthetic fixture failed'))); });
  child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'worker/wrangler-history-test.jsonc', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--persist-to', directory], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout?.on('data', s => { output += s; }); child.stderr?.on('data', s => { output += s; });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(300) })).ok) return; } catch { /* startup */ }
    if (child.exitCode !== null) throw new Error('Local history runtime exited: ' + output);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Local history runtime did not start: ' + output);
}, 30_000);
afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child?.kill('SIGKILL'); resolve(); }, 3000);
      child!.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
it('records through a native alarm without a live/departures demand request and exposes health only', async () => {
  // The health route neither polls upstream nor records evidence. The first DO
  // invocation only enables the persisted alarm; all evidence must arrive later.
  const firstText = await (await fetch(base + '/v1/collection')).text();
  const first = JSON.parse(firstText).collection;
  expect(first.enabled).toBe(true); expect(first.observations).toBe(0); expect(first.alarmAt).toBeGreaterThan(0);
  await expect.poll(async () => (await (await fetch(base + '/v1/collection')).json()).collection.observations, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await (await fetch(base + '/v1/collection')).json()).collection.archive.verifiedObjects, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  const text = await (await fetch(base + '/v1/collection')).text(), state = JSON.parse(text).collection;
  expect(state).toMatchObject({ enabled: true, reason: 'collecting', observations: 1, batches: 1, error: false });
  expect(state.lastSuccessAt).toBeGreaterThanOrEqual(first.lastSuccessAt ?? 0);
  expect(state.alarmAt).toBeGreaterThan(state.lastSuccessAt);
  for (const privateValue of ['history-local-test-token', 'history-local-bus', 'watermarks', '40.89', '-74.04']) expect(text).not.toContain(privateValue);
  expect((await fetch(base + '/v1/history')).status).toBe(404);
  expect((await fetch(base + '/v1/collection', { method: 'POST' })).status).toBe(405);
}, 20_000);
