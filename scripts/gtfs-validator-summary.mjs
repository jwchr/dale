import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const severities = ['ERROR', 'WARNING', 'INFO'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// v8.0.1 serializes notices as code, severity, totalNotices, sampleNotices:
// https://github.com/MobilityData/gtfs-validator/blob/v8.0.1/core/src/main/java/org/mobilitydata/gtfsvalidator/model/NoticeReport.java
// Version and feed identity come from the workflow's pinned jar and downloaded ZIP.
export function renderSummary(report, { validatorVersion, feedSha256, feedBytes }) {
  if (!isObject(report) || !Array.isArray(report.notices)) {
    throw new Error('report.json must contain a notices array.');
  }
  const totals = { ERROR: 0, WARNING: 0, INFO: 0 };
  const notices = report.notices.map((notice) => {
    if (!isObject(notice) || typeof notice.code !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(notice.code)
      || !severities.includes(notice.severity) || !Number.isSafeInteger(notice.totalNotices)
      || notice.totalNotices < 0) {
      throw new Error('report.json has an invalid notice; expected a code, ERROR/WARNING/INFO severity and nonnegative integer totalNotices.');
    }
    totals[notice.severity] += notice.totalNotices;
    if (!Number.isSafeInteger(totals[notice.severity])) {
      throw new Error('report.json severity total exceeds the safe integer limit.');
    }
    // Explicit whitelist: never copy sampleNotices or other row data into Markdown.
    return { code: notice.code, severity: notice.severity, count: notice.totalNotices };
  });
  if (typeof validatorVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(validatorVersion)
    || typeof feedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(feedSha256)
    || !Number.isSafeInteger(feedBytes) || feedBytes <= 0) {
    throw new Error('invalid metadata; supply GTFS_VALIDATOR_VERSION, GTFS_FEED_SHA256 and positive integer GTFS_FEED_BYTES.');
  }
  notices.sort((a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity)
    || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return [
    '## NJ Transit bus schedule validation',
    '',
    `Validator version: ${validatorVersion}`,
    `Feed SHA-256: \`${feedSha256}\``,
    `Feed size: ${feedBytes} bytes`,
    '',
    'Informational only. Research each notice against NJ Transit\'s file before changing Dale (D81).',
    '',
    '| Severity | Total notices |',
    '| --- | ---: |',
    ...severities.map((severity) => `| ${severity} | ${totals[severity]} |`),
    '',
    '| Notice code | Severity | Count |',
    '| --- | --- | ---: |',
    ...notices.map(({ code, severity, count }) => `| ${code} | ${severity} | ${count} |`),
    '',
  ].join('\n');
}

function main() {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/gtfs-validator-summary.mjs <report.json>.');
  let input;
  try {
    input = readFileSync(process.argv[2], 'utf8');
  } catch (error) {
    const reason = { ENOENT: 'file not found', EACCES: 'permission denied', EISDIR: 'path is a directory' }[error.code] ?? 'read failed';
    throw new Error(`cannot read report.json: ${reason}.`);
  }
  let report;
  try {
    report = JSON.parse(input);
  } catch {
    throw new Error('report.json is not valid JSON.');
  }
  const markdown = renderSummary(report, {
    validatorVersion: process.env.GTFS_VALIDATOR_VERSION,
    feedSha256: process.env.GTFS_FEED_SHA256,
    feedBytes: Number(process.env.GTFS_FEED_BYTES),
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${markdown}`);
    } catch {
      throw new Error('cannot append to GITHUB_STEP_SUMMARY.');
    }
  }
  process.stdout.write(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`GTFS validator summary: ${error.message}`);
    process.exitCode = 1;
  }
}
