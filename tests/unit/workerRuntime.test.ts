// Real local Cloudflare runtime + SQLite Durable Object; synthetic upstream only, no NJ Transit calls.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
let child: ChildProcess | undefined, base: string, directory: string | undefined;
beforeAll(async () => {
  const probe = createServer();
  const port = await new Promise<number>((resolve) => probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port)));
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  directory = await mkdtemp(join(tmpdir(), 'dale-worker-runtime-'));
  const fixture = spawn(process.execPath, ['scripts/worker-fixture.mjs'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { fixture.on('error', reject); fixture.on('exit', (n) => n === 0 ? resolve() : reject(new Error('Fixture creation failed'))); });
  child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'worker/wrangler-test.jsonc', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--persist-to', directory], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout?.on('data', (s) => { output += s; }); child.stderr?.on('data', (s) => { output += s; });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + '/health', { signal: AbortSignal.timeout(300) }); if (r.ok) return; } catch { /* still starting */ }
    if (child.exitCode !== null) throw new Error('Local Worker exited: ' + output);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Local Worker did not start: ' + output);
}, 30_000);
afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child?.kill('SIGKILL'); resolve(); }, 3000);
      child!.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
it('serves real Worker requests through a SQLite object without exposing secrets or contacting NJ Transit', async () => {
  const status = await (await fetch(base + '/v1/status')).json();
  expect(status.reportingBuses).toBe(1); expect(status.vehicles.state).toBe('ok');
  const response = await fetch(base + '/v1/live?trip=T1&date=20261104', { headers: { origin: 'https://jwchr.github.io' } });
  expect(response.headers.get('access-control-allow-origin')).toBe('https://jwchr.github.io');
  const text = await response.text(); expect(text).not.toContain('local-test-token');
  const packet = JSON.parse(text); expect(packet.observations[0].vehicleId).toBe('local-test-bus');
  expect(packet.tripInstanceId).toBe('T1@20261104');
  const query = encodeURIComponent(JSON.stringify([{ tripId: 'T1', serviceDate: '20261104', stopIndex: 1, toStopIndex: 2 }]));
  const upcoming = await (await fetch(base + '/v1/departures?q=' + query)).json();
  expect(upcoming.items[0].departure.stopIndex).toBe(1);
  expect(upcoming.items[0].departure.at).toBe(Date.parse('2026-11-04T12:25:00Z'));
  expect((await fetch(base + '/v1/live?trip=unknown&date=20261104')).status).toBe(400);
});
