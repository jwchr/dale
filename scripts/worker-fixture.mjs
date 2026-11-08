// Synthetic bundle check only. Deployment always overwrites this with an authenticated official G2 download.
import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { buildDataset } from './gtfs-lib.mjs';
const dir = new URL('../tests/fixtures/gtfs-mini/', import.meta.url);
const files = Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]));
const ds = buildDataset(files, { routeShortNames: ['165', '165T'], splitVariants: true, feedVersion: 'SYNTHETIC-DO-NOT-DEPLOY', builtAt: '2026-11-04T10:00:00Z' });
ds.meta.realtime = { provider: 'njt-bus-g2' };
mkdirSync(new URL('../worker/generated/', import.meta.url), { recursive: true });
const output = new URL('../worker/generated/corridor.json', import.meta.url), text = JSON.stringify(ds);
let previous;
try { previous = readFileSync(output, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
// Concurrent local runtime suites share this immutable synthetic input.
if (previous !== text) {
  const temporary = new URL(`../worker/generated/corridor-${process.pid}.tmp`, import.meta.url);
  writeFileSync(temporary, text); renameSync(temporary, output);
}
