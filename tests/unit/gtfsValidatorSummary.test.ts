import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Plain Node ESM operational helper has no declaration file.
import { renderSummary } from '../../scripts/gtfs-validator-summary.mjs';

const metadata = { validatorVersion: '8.0.1', feedSha256: 'a'.repeat(64), feedBytes: 123456 };
const sample = { stopName: 'synthetic-private-stop', tripId: 'synthetic-private-trip', row: 987654 };
const notice = (code: string, severity: string, totalNotices: number) => ({ code, severity, totalNotices, sampleNotices: [sample] });
const report = {
  summary: { agencyName: 'synthetic-private-agency' },
  notices: [
    notice('z_info', 'INFO', 8), notice('z_warning', 'WARNING', 7), notice('z_error', 'ERROR', 3),
    notice('a_info', 'INFO', 13), notice('a_warning', 'WARNING', 5), notice('a_error', 'ERROR', 2),
  ],
};

it('sorts errors before warnings before info and each severity by code without changing the input', () => {
  const before = structuredClone(report);
  const markdown = renderSummary(report, metadata);
  expect(markdown.split('\n').filter((line: string) => /^\| [az]_/.test(line))).toEqual([
    '| a_error | ERROR | 2 |', '| z_error | ERROR | 3 |',
    '| a_warning | WARNING | 5 |', '| z_warning | WARNING | 7 |',
    '| a_info | INFO | 13 |', '| z_info | INFO | 8 |',
  ]);
  expect(report).toEqual(before);
});

it('sums totalNotices rather than the number of samples and prints verified feed identity', () => {
  const markdown = renderSummary(report, metadata);
  expect(markdown).toContain('| ERROR | 5 |\n| WARNING | 12 |\n| INFO | 21 |');
  expect(markdown).toContain('Validator version: 8.0.1');
  expect(markdown).toContain(`Feed SHA-256: \`${metadata.feedSha256}\``);
  expect(markdown).toContain('Feed size: 123456 bytes');
});

it('never includes sample values or extra report fields', () => {
  const markdown = renderSummary(report, metadata);
  for (const value of [...Object.values(sample), report.summary.agencyName, 'sampleNotices', 'stopName', 'tripId']) {
    expect(markdown).not.toContain(String(value));
  }
});

it('accepts an empty notices array and a zero count', () => {
  expect(renderSummary({ notices: [] }, metadata)).toContain('| ERROR | 0 |\n| WARNING | 0 |\n| INFO | 0 |');
  expect(renderSummary({ notices: [notice('empty_count', 'ERROR', 0)] }, metadata)).toContain('| empty_count | ERROR | 0 |');
});

it.each([null, [], {}, { notices: {} }, { notices: [null] },
  { notices: [{ code: 'missing_fields' }] },
  { notices: [notice('bad_severity', 'FATAL', 1)] },
  { notices: [notice('bad_severity', '__proto__', 1)] },
  { notices: [notice('bad|code\ninjection', 'ERROR', 1)] },
  ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((n) => ({ notices: [notice('bad_count', 'ERROR', n)] })),
  { notices: [{ code: 'string_count', severity: 'ERROR', totalNotices: '2' }] },
  { notices: [notice('a_count', 'ERROR', Number.MAX_SAFE_INTEGER), notice('b_count', 'ERROR', 1)] },
])('rejects malformed reports without echoing row data (%#)', (invalid) => {
  expect(() => renderSummary(invalid, metadata)).toThrow(/report.json/);
});

it.each([
  { ...metadata, validatorVersion: '8.0.1\nunsafe' },
  { ...metadata, feedSha256: 'not-a-hash' },
  { ...metadata, feedBytes: 0 },
  { ...metadata, feedBytes: NaN },
])('rejects missing or invalid provenance (%#)', (invalid) => {
  expect(() => renderSummary(report, invalid)).toThrow(/invalid metadata/);
});

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const script = new URL('../../scripts/gtfs-validator-summary.mjs', import.meta.url);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gtfs-summary-'));
  directories.push(directory);
  return { input: join(directory, 'report.json'), summary: join(directory, 'summary.md') };
}
function run(input: string, summary: string) {
  return spawnSync(process.execPath, [script.pathname, input], { encoding: 'utf8', env: {
    ...process.env, GTFS_VALIDATOR_VERSION: metadata.validatorVersion, GTFS_FEED_SHA256: metadata.feedSha256,
    GTFS_FEED_BYTES: String(metadata.feedBytes), GITHUB_STEP_SUMMARY: summary,
  } });
}

it('appends the same Markdown to the run summary and succeeds even with ERROR notices', () => {
  const { input, summary } = fixture();
  writeFileSync(input, JSON.stringify(report));
  writeFileSync(summary, 'Existing summary\n');
  const result = run(input, summary);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe(renderSummary(report, metadata));
  expect(readFileSync(summary, 'utf8')).toBe(`Existing summary\n\n${result.stdout}`);
});

it.each(['missing', 'directory', 'json', 'shape', 'summary'] as const)('reports %s failures as one safe line and exits nonzero', (kind) => {
  const { input, summary } = fixture();
  if (kind !== 'missing' && kind !== 'directory') writeFileSync(input, kind === 'json' ? '{synthetic-private-row' : JSON.stringify(kind === 'shape' ? { notices: [sample] } : report));
  const result = run(kind === 'directory' ? tmpdir() : input, kind === 'summary' ? tmpdir() : summary);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim().split('\n')).toHaveLength(1);
  expect(result.stderr).toContain('GTFS validator summary: ');
  expect(result.stderr).toContain({ missing: 'file not found', directory: 'path is a directory', json: 'not valid JSON', shape: 'invalid notice', summary: 'cannot append' }[kind]);
  expect(result.stderr).not.toMatch(/synthetic-private|stopName|tripId/);
});
