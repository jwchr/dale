// Deletes work branches whose pull request was merged (owner request 2026-11-11: the builder's sandbox
// cannot delete branches, so they piled up). Run only by .github/workflows/branch-cleanup.yml.
//
// A branch is deleted only when ALL of these hold:
// - a pull request from this repository with that head branch was merged;
// - the branch still points at that merged pull request's last commit (nothing was pushed after);
// - no open pull request uses the branch;
// - it is not the default branch or another protected name.
// Anything else is kept and listed with the reason. Without APPLY=true nothing is deleted (dry run).

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
    remove.push({ name: branch.name, pr: merged.number });
  }
  return { remove, keep };
}

/** One ref path segment per branch-name segment, so names with slashes stay addressable. */
export const refPath = name => name.split('/').map(encodeURIComponent).join('/');

async function api(path, { method = 'GET' } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (method === 'DELETE') return response.status;
  if (!response.ok) throw new Error(`GitHub API ${method} ${path.split('?')[0]} returned ${response.status}`);
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
  let failed = 0;
  for (const { name, pr } of remove) {
    if (!apply) { console.log(`would delete ${name} (merged in #${pr})`); continue; }
    const status = await api(`/repos/${repo}/git/refs/heads/${refPath(name)}`, { method: 'DELETE' });
    if (status === 204) console.log(`deleted ${name} (merged in #${pr})`);
    else { failed++; console.log(`FAILED  ${name}: HTTP ${status}`); }
  }
  console.log(`${apply ? 'Deleted' : 'Dry run: would delete'} ${remove.length - failed} of ${branches.length} branches; kept ${keep.length}.`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error.message); process.exitCode = 1; });
