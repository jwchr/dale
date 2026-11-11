import { describe, expect, it } from 'vitest';
// @ts-expect-error pure ESM workflow helper without declaration files
import { deleteArgs, deleteOutcome, selectBranches } from '../../scripts/branch-cleanup.mjs';

const repo = 'jwchr/dale';
const pr = (number: number, ref: string, sha: string, over: Record<string, unknown> = {}) =>
  ({ number, state: 'closed', merged_at: '2026-11-11T17:48:00Z', head: { ref, sha, repo: { full_name: repo } }, ...over });

describe('branch cleanup selection', () => {
  it('deletes only branches whose merged pull request still matches the branch tip', () => {
    const branches = [
      { name: 'claude/home-fixes', sha: 'a1' },
      { name: 'claude/pushed-after-merge', sha: 'b2' },
      { name: 'claude/closed-unmerged', sha: 'c1' },
      { name: 'claude/no-pr', sha: 'd1' },
      { name: 'claude/open', sha: 'e1' },
      { name: 'main', sha: 'f1' },
    ];
    const pulls = [
      pr(141, 'claude/home-fixes', 'a1'),
      pr(130, 'claude/pushed-after-merge', 'b1'),
      pr(120, 'claude/closed-unmerged', 'c1', { merged_at: null }),
      pr(142, 'claude/open', 'e1', { state: 'open', merged_at: null }),
      pr(1, 'main', 'f1'),
    ];
    expect(selectBranches({ branches, pulls, repo, defaultBranch: 'main' })).toEqual({
      remove: [{ name: 'claude/home-fixes', sha: 'a1', pr: 141 }],
      keep: [
        { name: 'claude/pushed-after-merge', reason: 'new commits after merge' },
        { name: 'claude/closed-unmerged', reason: 'no merged pull request' },
        { name: 'claude/no-pr', reason: 'no merged pull request' },
        { name: 'claude/open', reason: 'open pull request' },
        { name: 'main', reason: 'protected' },
      ],
    });
  });

  it('keeps a reused branch that has a newer open pull request, even if an older one merged', () => {
    const branches = [{ name: 'claude/reused', sha: 'x2' }];
    const pulls = [pr(100, 'claude/reused', 'x2'), pr(150, 'claude/reused', 'x2', { state: 'open', merged_at: null })];
    expect(selectBranches({ branches, pulls, repo, defaultBranch: 'main' }).remove).toEqual([]);
  });

  it('ignores pull requests from forks that happen to use the same branch name', () => {
    const branches = [{ name: 'patch-1', sha: 'z1' }];
    const pulls = [pr(90, 'patch-1', 'z1', { head: { ref: 'patch-1', sha: 'z1', repo: { full_name: 'someone/dale' } } })];
    expect(selectBranches({ branches, pulls, repo, defaultBranch: 'main' })).toEqual({ remove: [], keep: [{ name: 'patch-1', reason: 'no merged pull request' }] });
  });

  it('protects the default branch even when it is not named main', () => {
    const branches = [{ name: 'trunk', sha: 't1' }];
    const pulls = [pr(5, 'trunk', 't1')];
    expect(selectBranches({ branches, pulls, repo, defaultBranch: 'trunk' }).remove).toEqual([]);
  });

  it('limits a merge-triggered run to that pull request branch', () => {
    const branches = [{ name: 'claude/a', sha: 'a1' }, { name: 'claude/b', sha: 'b1' }];
    const pulls = [pr(1, 'claude/a', 'a1'), pr(2, 'claude/b', 'b1')];
    expect(selectBranches({ branches, pulls, repo, defaultBranch: 'main', only: 'claude/b' })).toEqual({ remove: [{ name: 'claude/b', sha: 'b1', pr: 2 }], keep: [] });
  });

  it('deletes with a lease on the checked commit, as separate arguments with no shell', () => {
    expect(deleteArgs('claude/home-fixes', 'a1')).toEqual(['push', '--porcelain', '--force-with-lease=refs/heads/claude/home-fixes:a1', 'origin', ':refs/heads/claude/home-fixes']);
  });

  it('treats a moved or missing branch as kept and anything else as a failure', () => {
    // Messages recorded from git 2.x against a local bare repository.
    expect(deleteOutcome({ status: 0, stdout: '-\t:refs/heads/claude/x\t[deleted]\nDone' })).toBe('deleted');
    expect(deleteOutcome({ status: 1, stdout: '!\t(delete):refs/heads/claude/y\t[rejected] (stale info)\nDone', stderr: "error: failed to push some refs to 'origin'" })).toBe('kept');
    expect(deleteOutcome({ status: 128, stderr: 'remote: Permission to jwchr/dale.git denied to github-actions[bot].\nfatal: unable to access' })).toBe('failed');
  });
});
