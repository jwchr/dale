// Deletes work branches whose pull request was merged (owner request 2026-11-11: the builder's sandbox
// cannot delete branches, so they piled up). Run only by .github/workflows/branch-cleanup.yml.
//
// A branch is deleted only when ALL of these hold:
// - a pull request from this repository with that head branch was merged;
// - the branch still points at that merged pull request's last commit (nothing was pushed after);
// - no open pull request uses the branch;
// - it is not the default branch or another protected name.
// Anything else is kept and listed with the reason. Without APPLY=true nothing is deleted (dry run).
// The deletion itself is conditional: git deletes the ref only if it still points at the checked
// commit (--force-with-lease), so a push made after the check can never be deleted.

import { spawnSync } from 'node:child_process';

const KEEP = new Set(['main', 'gh-pages']);
export const MAX_DELETIONS = 100;

/**
 * Pure selection. `branches`: [{ name, sha }]. `pulls`: GitHub pull objects (state, merged_at,
 * head.ref, head.sha, head.repo.full_name). Returns { remove: [{ name, pr }], keep: [{ name, reason }] }.
 */
export function selectBranches({ branches, pulls, repo, defaultBranch, only }) {
  const own = pulls.filter(pr => pr.head?.repo?.full_name === repo);
  const remove = [], keep = [];
  for (const branch of branches) {
    if (only && branch.name !== only) continue;
    const mine = own.filter(pr => pr.head.ref === branch.name);
    let reason = '';
    if (KEEP.has(branch.name) || branch.name === defaultBranch) reason = 'protected';
    else if (mine.some(pr => pr.state === 'open')) reason = 'open pull request';
    else if (!mine.some(pr => pr.merged_at)) reason = 'no merged pull request';
    else if (!mine.some(pr => pr.merged_at && pr.head.sha === branch.sha)) reason = 'new commits after merge';
    if (reason) { keep.push({ name: branch.name, reason }); continue; }
    const merged = mine.filter(pr => pr.merged_at && pr.head.sha === branch.sha).sort((a, b) => b.number - a.number)[0];
    remove.push({ name: branch.name, sha: branch.sha, pr: merged.number });
  }
  return { remove, keep };
}

/** Git arguments that delete `refs/heads/<name>` only if it still points at `sha`. No shell is involved. */
export const deleteArgs = (name, sha) => ['push', '--porcelain', `--force-with-lease=refs/heads/${name}:${sha}`, 'origin', `:refs/heads/${name}`];

/**
 * Classifies a finished `git push` deletion: deleted, kept (the branch moved or is already gone, which
 * is the safe outcome) or failed (anything else, such as a permission error).
 */
export function deleteOutcome({ status, stdout = '', stderr = '' }) {
  if (status === 0) return 'deleted';
  const text = `${stdout}\n${stderr}`;
  if (/stale info|remote ref does not exist|unable to delete '[^']*': remote ref does not exist/i.test(text)) return 'kept';
  return 'failed';
}

async function api(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`GitHub API GET ${path.split('?')[0]} returned ${response.status}`);
  return response.json();
}

async function all(path) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`More than 2000 items at ${path}; refusing to guess`);
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY, apply = process.env.APPLY === 'true', only = process.env.ONLY_BRANCH || undefined;
  if (!repo || !process.env.GITHUB_TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const { default_branch: defaultBranch } = await api(`/repos/${repo}`);
  const branches = (await all(`/repos/${repo}/branches`)).map(b => ({ name: b.name, sha: b.commit.sha }));
  const pulls = await all(`/repos/${repo}/pulls?state=all`);
  const { remove, keep } = selectBranches({ branches, pulls, repo, defaultBranch, only });
  if (remove.length > MAX_DELETIONS) throw new Error(`${remove.length} branches selected, more than ${MAX_DELETIONS}; refusing`);
  for (const { name, reason } of keep) console.log(`keep    ${name} (${reason})`);
  let deleted = 0, failed = 0;
  for (const { name, sha, pr } of remove) {
    if (!apply) { console.log(`would delete ${name} (merged in #${pr})`); continue; }
    const result = spawnSync('git', deleteArgs(name, sha), { encoding: 'utf8' });
    const outcome = deleteOutcome(result);
    if (outcome === 'deleted') { deleted++; console.log(`deleted ${name} (merged in #${pr})`); }
    else if (outcome === 'kept') console.log(`keep    ${name} (changed or already gone since the check)`);
    else { failed++; console.log(`FAILED  ${name}: ${(result.stderr || '').trim().split('\n').pop()}`); }
  }
  console.log(apply ? `Deleted ${deleted} of ${branches.length} branches; ${failed} failed.` : `Dry run: would delete ${remove.length} of ${branches.length} branches; kept ${keep.length}.`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error.message); process.exitCode = 1; });
