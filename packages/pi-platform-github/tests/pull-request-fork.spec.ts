/**
 * @file Integration tests for fork-based pull request creation and updates.
 *
 * Verifies the end-to-end behaviour of `create_pull_request` /
 * `update_pull_request` when PRs are opened from the agent's fork:
 *
 *  - the agent's fork is created on first use and reused afterwards,
 *  - the branch is pushed to the fork (`pi-fork` remote), not `origin`,
 *  - the PR head uses the cross-repository `owner:branch` form,
 *  - updates are pushed to the fork as well,
 *  - the same-repository fallback applies when the token owner already
 *    owns the repository,
 *  - fork-creation failures surface an actionable PAT hint.
 *
 * Uses real git repositories (bare remotes for the repository and the fork)
 * plus mocked Octokit endpoints.
 */

import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createPullRequest, updatePullRequest } from '@alexanderfortin/pi-platform-github';
import type { GitHubModuleDeps } from '@alexanderfortin/pi-platform-github';
import { setupForkGitRepo, cleanupGitRepo, isolateGitConfig } from './helpers/git-repo';

// Isolate git ops from the host's global/system git config (see isolateGitConfig).
isolateGitConfig();

const noop = (): void => {};

const REPO = { owner: 'test-owner', repo: 'test-repo' };
const FORK = { owner: 'pi-bot', repo: 'test-repo' };

/** Octokit-style error with a status code. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** Default pull request shape returned by the pulls.create mock. */
const PR_DATA = {
  number: 99,
  html_url: 'https://github.com/test-owner/test-repo/pull/99',
};

/**
 * Build deps with the given octokit mock and workspace.
 *
 * The payload carries `default_branch` so no repository lookup is needed for
 * base-branch resolution — `repos.get` is exercised only by the fork logic.
 */
function createDeps(octokit: unknown, workspace: string): GitHubModuleDeps {
  return {
    octokit: octokit as any,
    context: {
      repo: REPO,
      issue: { number: 42 },
      eventName: 'issue_comment',
      payload: { repository: { default_branch: 'main' } },
      serverUrl: 'https://github.com',
      runId: 1,
      workspace,
    },
    logger: {
      debug: noop,
      info: noop,
      warning: noop,
      notice: noop,
      error: noop,
    },
  } as GitHubModuleDeps;
}

/** Octokit mock where the token authenticates as the fork owner and the fork already exists. */
function existingForkOctokit() {
  return {
    rest: {
      users: {
        getAuthenticated: vi.fn(() => Promise.resolve({ data: { login: FORK.owner } })),
      },
      repos: {
        get: vi.fn(() =>
          Promise.resolve({
            data: {
              name: FORK.repo,
              fork: true,
              parent: { full_name: `${REPO.owner}/${REPO.repo}` },
            },
          })
        ),
        createFork: vi.fn(() => Promise.resolve({ data: { name: FORK.repo } })),
        getBranch: vi.fn(() => Promise.resolve({ data: { name: 'main' } })),
      },
      pulls: {
        create: vi.fn(() =>
          Promise.resolve({
            data: {
              ...PR_DATA,
              head: { ref: 'pi/issue42-1234567890' },
              base: { ref: 'main' },
            },
          })
        ),
      },
    },
  };
}

/** Octokit mock where the token authenticates as the fork owner and no fork exists yet. */
function missingForkOctokit() {
  return {
    rest: {
      users: {
        getAuthenticated: vi.fn(() => Promise.resolve({ data: { login: FORK.owner } })),
      },
      repos: {
        get: vi.fn(() => Promise.reject(httpError(404, 'Not Found'))),
        createFork: vi.fn(() => Promise.resolve({ data: { name: FORK.repo } })),
        getBranch: vi.fn(() => Promise.resolve({ data: { name: 'main' } })),
      },
      pulls: {
        create: vi.fn(() =>
          Promise.resolve({
            data: {
              ...PR_DATA,
              head: { ref: 'pi/issue42-1234567890' },
              base: { ref: 'main' },
            },
          })
        ),
      },
    },
  };
}

/** Octokit mock where the token authenticates as the repository owner. */
function ownerOctokit() {
  return {
    rest: {
      users: {
        getAuthenticated: vi.fn(() => Promise.resolve({ data: { login: REPO.owner } })),
      },
      repos: {
        get: vi.fn(),
        createFork: vi.fn(),
      },
      pulls: {
        create: vi.fn(() =>
          Promise.resolve({
            data: {
              ...PR_DATA,
              head: { ref: 'pi/issue42-1234567890' },
              base: { ref: 'main' },
            },
          })
        ),
      },
    },
  };
}

/** List branches of a bare repository (for asserting push targets). */
function remoteBranches(dir: string): string[] {
  return execSync('git branch', { cwd: dir, encoding: 'utf-8' })
    .split('\n')
    .map(l => l.trim().replace(/^\*\s*/, ''))
    .filter(l => l.length > 0);
}

describe('createPullRequest — fork-based flow', () => {
  let repo: ReturnType<typeof setupForkGitRepo>;

  beforeEach(() => {
    repo = setupForkGitRepo({
      upstreamOwner: REPO.owner,
      upstreamRepo: REPO.repo,
      forkOwner: FORK.owner,
      forkRepo: FORK.repo,
    });
    if (repo) {
      fs.writeFileSync(path.join(repo.workspace, 'change.txt'), 'agent change');
    }
  });

  afterEach(() => {
    if (repo) {
      cleanupGitRepo(repo.workspace);
    }
  });

  test('opens the PR from an existing fork (head owner:branch, branch in fork)', async () => {
    if (!repo) {
      return;
    }
    const octokit = existingForkOctokit();
    const deps = createDeps(octokit, repo.workspace);

    const result = await createPullRequest(deps, { title: 'Fix bug' });

    // The token user is the fork owner, the fork exists and is reused.
    expect(octokit.rest.users.getAuthenticated).toHaveBeenCalled();
    expect(octokit.rest.repos.get).toHaveBeenCalledWith({
      owner: FORK.owner,
      repo: FORK.repo,
    });
    expect(octokit.rest.repos.createFork).not.toHaveBeenCalled();

    // The PR head uses the cross-repository "owner:branch" form.
    const createArgs = octokit.rest.pulls.create.mock.calls[0]![0];
    expect(createArgs.owner).toBe(REPO.owner);
    expect(createArgs.repo).toBe(REPO.repo);
    expect(createArgs.base).toBe('main');
    expect(createArgs.head).toMatch(/^pi-bot:pi\/issue42-\d+$/);

    // The branch was pushed to the fork, not to the target repository.
    expect(remoteBranches(repo.forkDir)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^pi\/issue42-\d+$/)])
    );
    expect(remoteBranches(repo.upstreamDir)).toEqual(['main']);

    // A pi-fork remote points at the fork.
    const remotes = execSync('git remote -v', { cwd: repo.workspace, encoding: 'utf-8' });
    expect(remotes).toContain('pi-fork');
    expect(remotes).toContain(repo.forkDir);

    // Details record the fork.
    expect(result.details.prCreated).toBe(true);
    expect(result.details.pullRequestNumber).toBe(99);
    expect(result.details.forkOwner).toBe(FORK.owner);
    expect(result.details.forkRepo).toBe(FORK.repo);
  });

  test('creates the fork on first use, then pushes and opens the PR from it', async () => {
    if (!repo) {
      return;
    }
    const octokit = missingForkOctokit();
    const deps = createDeps(octokit, repo.workspace);

    const result = await createPullRequest(deps, { title: 'Fix bug' });

    // The fork was created for the token owner.
    expect(octokit.rest.repos.createFork).toHaveBeenCalledWith({
      owner: REPO.owner,
      repo: REPO.repo,
    });
    // Freshly created forks get a readiness check on the default branch.
    expect(octokit.rest.repos.getBranch).toHaveBeenCalledWith({
      owner: FORK.owner,
      repo: FORK.repo,
      branch: 'main',
    });

    // The branch lives in the fork and the PR is opened from it.
    expect(remoteBranches(repo.forkDir)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^pi\/issue42-\d+$/)])
    );
    expect(remoteBranches(repo.upstreamDir)).toEqual(['main']);
    const createArgs = octokit.rest.pulls.create.mock.calls[0]![0];
    expect(createArgs.head).toMatch(/^pi-bot:pi\/issue42-\d+$/);
    expect(result.details.forkOwner).toBe(FORK.owner);
  });

  test('dry run performs no API calls and no fork resolution', async () => {
    if (!repo) {
      return;
    }
    const octokit = existingForkOctokit();
    const deps = createDeps(octokit, repo.workspace);

    const result = await createPullRequest(deps, { title: 'Fix bug', dryRun: true });

    expect(result.details.dryRun).toBe(true);
    expect(octokit.rest.users.getAuthenticated).not.toHaveBeenCalled();
    expect(octokit.rest.repos.createFork).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
  });

  test('pushes to the repository itself when the token owner owns it', async () => {
    if (!repo) {
      return;
    }
    const octokit = ownerOctokit();
    const deps = createDeps(octokit, repo.workspace);

    const result = await createPullRequest(deps, { title: 'Fix bug' });

    // No fork lookup or creation: a user cannot fork their own repository.
    expect(octokit.rest.repos.get).not.toHaveBeenCalled();
    expect(octokit.rest.repos.createFork).not.toHaveBeenCalled();

    // The branch was pushed to origin (the repository itself)…
    expect(remoteBranches(repo.upstreamDir)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^pi\/issue42-\d+$/)])
    );
    expect(remoteBranches(repo.forkDir)).toEqual([]);

    // …and the PR head is the plain branch name.
    const createArgs = octokit.rest.pulls.create.mock.calls[0]![0];
    expect(createArgs.head).toMatch(/^pi\/issue42-\d+$/);
    expect(result.details.forkOwner).toBeUndefined();
  });

  test('fails with an actionable error when the fork cannot be created', async () => {
    if (!repo) {
      return;
    }
    const octokit = missingForkOctokit();
    octokit.rest.repos.createFork = vi.fn(() =>
      Promise.reject(httpError(403, 'Resource not accessible by integration'))
    );
    const deps = createDeps(octokit, repo.workspace);

    await expect(createPullRequest(deps, { title: 'Fix bug' })).rejects.toThrow(
      /Failed to create a fork of "test-owner\/test-repo" for "pi-bot".*personal access token/s
    );

    // Nothing was pushed anywhere — the failure happens before the commit.
    expect(remoteBranches(repo.upstreamDir)).toEqual(['main']);
    expect(remoteBranches(repo.forkDir)).toEqual([]);
  });

  test('compare-URL fallback uses the fork head when pulls.create is denied', async () => {
    if (!repo) {
      return;
    }
    const octokit = existingForkOctokit();
    octokit.rest.pulls.create = vi.fn(() => Promise.reject(httpError(403, "Can't read pulls")));
    const deps = createDeps(octokit, repo.workspace);

    const result = await createPullRequest(deps, { title: 'Fix bug' });

    expect(result.details.prCreated).toBe(false);
    // The compare URL targets the fork's branch (cross-repository head).
    expect(result.details.compareUrl).toMatch(/\/compare\/main\.\.\.pi-bot:pi\/issue42-\d+$/);
    expect(result.details.forkOwner).toBe(FORK.owner);
    // The branch was still pushed to the fork.
    expect(remoteBranches(repo.forkDir)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^pi\/issue42-\d+$/)])
    );
  });
});

describe('updatePullRequest — fork-based flow', () => {
  let repo: ReturnType<typeof setupForkGitRepo>;

  beforeEach(() => {
    repo = setupForkGitRepo({
      upstreamOwner: REPO.owner,
      upstreamRepo: REPO.repo,
      forkOwner: FORK.owner,
      forkRepo: FORK.repo,
    });
    if (repo) {
      fs.writeFileSync(path.join(repo.workspace, 'change.txt'), 'agent change');
    }
  });

  afterEach(() => {
    if (repo) {
      cleanupGitRepo(repo.workspace);
    }
  });

  test('pushes follow-up commits to the fork branch', async () => {
    if (!repo) {
      return;
    }

    // Step 1: create the PR from the fork (reused existing fork).
    const createOctokit = existingForkOctokit();
    await createPullRequest(createDeps(createOctokit, repo.workspace), { title: 'Fix bug' });

    // Recover the actual branch name from the create call.
    const createArgs = createOctokit.rest.pulls.create.mock.calls[0]![0];
    const branch = (createArgs.head as string).split(':')[1]!;
    expect(branch).toMatch(/^pi\/issue42-\d+$/);

    // Step 2: update the PR — pulls.get reports a fork head repository.
    const pullsGet = vi.fn(() =>
      Promise.resolve({
        status: 200,
        data: {
          number: 99,
          html_url: PR_DATA.html_url,
          head: {
            ref: branch,
            sha: 'head-sha',
            repo: { owner: { login: FORK.owner }, name: FORK.repo },
          },
          base: { ref: 'main' },
        },
      })
    );
    const pullsUpdate = vi.fn(() => Promise.resolve({ data: { number: 99 } }));
    const updateDeps = createDeps(
      { rest: { pulls: { get: pullsGet, update: pullsUpdate } } },
      repo.workspace
    );

    // A follow-up change in the working tree.
    fs.writeFileSync(path.join(repo.workspace, 'follow-up.txt'), 'more work');

    const result = await updatePullRequest(updateDeps, { message: 'Follow-up' });

    // The update pushed a new commit to the fork's branch (2 commits:
    // create + follow-up).
    expect(result.details.commitSha).toMatch(/^[0-9a-f]{7,40}$/);
    const forkLog = execSync(`git log --oneline ${branch}`, {
      cwd: repo.forkDir,
      encoding: 'utf-8',
    });
    expect(forkLog.trim().split('\n').length).toBe(2);
    expect(forkLog).toContain('Follow-up');
    // The upstream repository still only has main.
    expect(remoteBranches(repo.upstreamDir)).toEqual(['main']);
  });

  test('pushes to origin for same-repository PRs', async () => {
    if (!repo) {
      return;
    }

    // A same-repository PR: head.repo equals the context repository.
    const branch = 'feature-branch';
    // Seed the branch on the upstream remote so the checkout can fetch it.
    execSync('git checkout -b feature-branch', { cwd: repo.workspace, stdio: 'pipe' });
    fs.writeFileSync(path.join(repo.workspace, 'seed.txt'), 'seed');
    execSync('git add seed.txt', { cwd: repo.workspace, stdio: 'pipe' });
    execSync('git commit -m seed', { cwd: repo.workspace, stdio: 'pipe' });
    execSync('git push -u origin feature-branch', { cwd: repo.workspace, stdio: 'pipe' });
    execSync('git checkout main', { cwd: repo.workspace, stdio: 'pipe' });

    const pullsGet = vi.fn(() =>
      Promise.resolve({
        status: 200,
        data: {
          number: 99,
          html_url: PR_DATA.html_url,
          head: {
            ref: branch,
            sha: 'head-sha',
            repo: { owner: { login: REPO.owner }, name: REPO.repo },
          },
          base: { ref: 'main' },
        },
      })
    );
    const deps = createDeps(
      { rest: { pulls: { get: pullsGet, update: vi.fn(() => Promise.resolve({ data: {} })) } } },
      repo.workspace
    );

    fs.writeFileSync(path.join(repo.workspace, 'update.txt'), 'update');

    const result = await updatePullRequest(deps, { message: 'Same-repo update' });

    expect(result.details.commitSha).toMatch(/^[0-9a-f]{7,40}$/);
    // The commit landed on the upstream remote's branch.
    const upstreamLog = execSync(`git log --oneline ${branch}`, {
      cwd: repo.upstreamDir,
      encoding: 'utf-8',
    });
    expect(upstreamLog).toContain('Same-repo update');
    // No pi-fork remote is configured for same-repository PRs.
    const remotes = execSync('git remote', { cwd: repo.workspace, encoding: 'utf-8' });
    expect(remotes).not.toContain('pi-fork');
  });
});
