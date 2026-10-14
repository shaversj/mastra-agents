import { describe, expect, it, vi } from 'vitest';

import { defaultLifecycleLabels } from '../src/domain/lifecycle.js';
import { proposalIdentity } from '../src/domain/proposal.js';
import { createLeaseGuard, type LeaseRecord } from '../src/github/lease.js';
import {
  FencedGitHubMutationClient,
  type GitHubMutationTransport,
} from '../src/github/mutation-client.js';
import {
  cleanupProposal,
  reconcileConfirmedProposal,
  reconcileFixProposal,
  reconcileLifecycleState,
  reconcileRejectedProposal,
  reconcileTriageReport,
} from '../src/github/reconcile.js';

const proposal = proposalIdentity({
  baseSha: 'a'.repeat(40),
  branch: 'triagebot/fix-42',
  headSha: 'b'.repeat(40),
});

class FakeGitHub implements GitHubMutationTransport {
  calls: string[] = [];
  comments: Array<{ authorIsAction: boolean; body: string; id: number }> = [];
  deletedBranches: string[] = [];
  failAfter: number | undefined;
  labels = [defaultLifecycleLabels.needs_triage];
  nextId = 1;
  prs: Array<{
    authorIsAction: boolean;
    base: string;
    body: string;
    head: string;
    headSha: string;
    id: number;
    open: boolean;
    title: string;
  }> = [];

  private mutate(name: string) {
    this.calls.push(name);
    if (this.failAfter === this.calls.length) throw new Error(`CRASH_AFTER_${name}`);
  }

  async createComment(_issue: number, body: string) {
    const value = { authorIsAction: true, body, id: this.nextId++ };
    this.comments.push(value);
    this.mutate('createComment');
    return value;
  }
  async createPullRequest(input: {
    base: string;
    body: string;
    head: string;
    headSha: string;
    title: string;
  }) {
    const value = { ...input, authorIsAction: true, id: this.nextId++, open: true };
    this.prs.push(value);
    this.mutate('createPullRequest');
    return value;
  }
  async deleteBranch(branch: string) {
    this.deletedBranches.push(branch);
    this.mutate('deleteBranch');
  }
  async getBranchSha() {
    return proposal.headSha;
  }
  async listComments() {
    return this.comments;
  }
  async listPullRequests(input: { base?: string; head: string }) {
    return this.prs.filter(
      (pr) =>
        (input.base === undefined || pr.base === input.base) && pr.head === input.head && pr.open,
    );
  }
  async readLabels() {
    return this.labels;
  }
  async setLabels(_issue: number, labels: string[]) {
    this.labels = [...labels];
    this.mutate('setLabels');
  }
}

function client(fake: FakeGitHub, lease = { assertCurrent: vi.fn(async () => undefined) }) {
  return { api: new FencedGitHubMutationClient(fake, lease), lease };
}

const identity = {
  eventFingerprint: 'event-1',
  fencingToken: 'fence-1',
  generation: 1,
  issueNumber: 42,
  repository: 'owner/repo',
};

describe('fenced GitHub reconciliation', () => {
  it('publishes one idempotent trusted-rendered report for a triage outcome', async () => {
    const fake = new FakeGitHub();
    const { api } = client(fake);
    const report = {
      details: ['The report needs additional reproduction details.'],
      headline: 'More information is needed',
    };
    await reconcileTriageReport({
      api,
      identity,
      labels: defaultLifecycleLabels,
      reasonCode: 'missing_steps',
      report,
      state: 'needs_reproduction',
      stoppedAt: 'reproduce',
    });
    await reconcileTriageReport({
      api,
      identity,
      labels: defaultLifecycleLabels,
      reasonCode: 'missing_steps',
      report,
      state: 'needs_reproduction',
      stoppedAt: 'reproduce',
    });

    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]?.body).toContain('More information is needed');
    expect(fake.comments[0]?.body).not.toContain('missing_steps');
    expect(fake.labels).toEqual([defaultLifecycleLabels.needs_reproduction]);
  });

  it.each([1, 2])('repairs a triage report after mutation crash point %s', async (failAfter) => {
    const fake = new FakeGitHub();
    const { api } = client(fake);
    const input = {
      api,
      identity,
      labels: defaultLifecycleLabels,
      reasonCode: 'missing_steps',
      report: {
        details: ['The report needs additional reproduction details.'],
        headline: 'More information is needed',
      },
      state: 'needs_reproduction' as const,
      stoppedAt: 'reproduce',
    };
    fake.failAfter = failAfter;
    await expect(reconcileTriageReport(input)).rejects.toThrow();
    fake.failAfter = undefined;
    fake.calls = [];

    await reconcileTriageReport(input);

    expect(fake.comments).toHaveLength(1);
    expect(fake.labels).toEqual([defaultLifecycleLabels.needs_reproduction]);
  });

  it.each([
    'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
    '```ts\nconst sourceCanary = true;\n```',
    'pnpm exec secret-command --token source-canary',
    '@everyone follow https://evil.example/phish',
  ])('rejects unsafe report semantics before mutation: %s', async (detail) => {
    const fake = new FakeGitHub();
    const { api } = client(fake);
    await expect(
      reconcileTriageReport({
        api,
        identity,
        labels: defaultLifecycleLabels,
        reasonCode: 'missing_steps',
        report: { details: [detail], headline: 'Triage complete' },
        state: 'needs_reproduction',
        stoppedAt: 'reproduce',
      }),
    ).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });

  it.each([
    [{ status: 'skipped', urls: [] } as const],
    [{ status: 'failed', urls: [], reasonCode: 'PREVIEW_LAUNCH_FAILED' } as const],
  ])('keeps a published proposal fix pending when preview is unavailable %#', async (preview) => {
    const fake = new FakeGitHub();
    const { api, lease } = client(fake);
    const result = await reconcileFixProposal({
      allowedAncillaryLabels: ['pkg:core'],
      ancillaryLabels: ['pkg:core'],
      api,
      identity,
      labels: defaultLifecycleLabels,
      preview,
      proposal,
      report: {
        details: ['The proposed change passed bounded verification.'],
        headline: 'A verified fix is ready',
      },
    });
    expect(result.state).toBe('fix_pending');
    expect(fake.labels).toEqual([defaultLifecycleLabels.fix_pending, 'pkg:core']);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]?.body).toContain(`${proposal.branch}@${proposal.headSha}`);
    expect(fake.comments[0]?.body).toContain('A verified fix is ready');
    expect(lease.assertCurrent).toHaveBeenCalledTimes(2);
  });

  it('discloses automatic PR confirmation bypass without confirm or reject instructions', async () => {
    const fake = new FakeGitHub();
    const { api } = client(fake);

    await reconcileFixProposal({
      ancillaryLabels: [],
      api,
      confirmationRequired: false,
      identity,
      labels: defaultLifecycleLabels,
      preview: { status: 'skipped', urls: [] },
      proposal,
    });

    expect(fake.comments[0]?.body).toContain('confirmation step is bypassed');
    expect(fake.comments[0]?.body).not.toContain('confirm or reject');
  });

  it('replaces conflicting lifecycle labels on failure while preserving unrelated labels', async () => {
    const fake = new FakeGitHub();
    fake.labels = [
      'customer-reported',
      defaultLifecycleLabels.needs_triage,
      defaultLifecycleLabels.fix_pending,
    ];
    const { api } = client(fake);

    await expect(
      reconcileLifecycleState({
        api,
        issueNumber: 42,
        labels: defaultLifecycleLabels,
        target: 'failed',
      }),
    ).rejects.toThrowError('LIFECYCLE_LABEL_CONFLICT');
    await reconcileLifecycleState({
      api,
      issueNumber: 42,
      labels: defaultLifecycleLabels,
      replaceConflicts: true,
      target: 'failed',
    });

    expect(fake.labels).toEqual([defaultLifecycleLabels.failed, 'customer-reported']);
  });

  it('adopts an existing matching PR and repairs state without duplication', async () => {
    const fake = new FakeGitHub();
    fake.prs.push({
      authorIsAction: true,
      base: 'develop',
      body: 'body',
      head: proposal.branch,
      headSha: proposal.headSha,
      id: 10,
      open: true,
      title: 'Fix issue',
    });
    const { api } = client(fake);
    await reconcileConfirmedProposal({
      api,
      identity,
      labels: defaultLifecycleLabels,
      prContent: { bodyFields: ['Fixes failure.'], title: 'Fix issue' },
      proposal,
      resolvedDefaultBranch: 'develop',
    });
    await reconcileConfirmedProposal({
      api,
      identity,
      labels: defaultLifecycleLabels,
      prContent: { bodyFields: ['Fixes failure.'], title: 'Fix issue' },
      proposal,
      resolvedDefaultBranch: 'develop',
    });
    expect(fake.prs).toHaveLength(1);
    expect(fake.labels).toEqual([defaultLifecycleLabels.fix_verified]);
  });

  it('rejects a matching pull request authored by another actor', async () => {
    const fake = new FakeGitHub();
    fake.prs.push({
      authorIsAction: false,
      base: 'develop',
      body: 'copied action body',
      head: proposal.branch,
      headSha: proposal.headSha,
      id: 10,
      open: true,
      title: 'Fix issue',
    });
    const { api } = client(fake);

    await expect(
      reconcileConfirmedProposal({
        api,
        identity,
        labels: defaultLifecycleLabels,
        prContent: { bodyFields: ['Fixes failure.'], title: 'Fix issue' },
        proposal,
        resolvedDefaultBranch: 'develop',
      }),
    ).rejects.toThrow('PULL_REQUEST_OWNERSHIP_CONFLICT');

    expect(fake.prs).toHaveLength(1);
  });

  it('repairs a PR-created-before-state crash without creating a second PR', async () => {
    const fake = new FakeGitHub();
    const { api } = client(fake);
    fake.failAfter = 1;
    await expect(
      reconcileConfirmedProposal({
        api,
        identity,
        labels: defaultLifecycleLabels,
        prContent: { bodyFields: ['Fixes failure.'], title: 'Fix issue' },
        proposal,
        resolvedDefaultBranch: 'develop',
      }),
    ).rejects.toThrow('CRASH_AFTER_createPullRequest');
    fake.failAfter = undefined;
    fake.calls = [];
    await reconcileConfirmedProposal({
      api,
      identity,
      labels: defaultLifecycleLabels,
      prContent: { bodyFields: ['Fixes failure.'], title: 'Fix issue' },
      proposal,
      resolvedDefaultBranch: 'develop',
    });
    expect(fake.prs).toHaveLength(1);
    expect(fake.prs[0]?.base).toBe('develop');
    expect(fake.labels).toEqual([defaultLifecycleLabels.fix_verified]);
  });

  it.each([1, 2])(
    'repairs proposal publication after mutation crash point %s',
    async (failAfter) => {
      const fake = new FakeGitHub();
      const { api } = client(fake);
      fake.failAfter = failAfter;
      await expect(
        reconcileFixProposal({
          allowedAncillaryLabels: ['pkg:core'],
          ancillaryLabels: ['pkg:core'],
          api,
          identity,
          labels: defaultLifecycleLabels,
          preview: { status: 'skipped', urls: [] },
          proposal,
        }),
      ).rejects.toThrow();
      fake.failAfter = undefined;
      fake.calls = [];
      await reconcileFixProposal({
        allowedAncillaryLabels: ['pkg:core'],
        ancillaryLabels: ['pkg:core'],
        api,
        identity,
        labels: defaultLifecycleLabels,
        preview: { status: 'skipped', urls: [] },
        proposal,
      });
      expect(fake.comments).toHaveLength(1);
      expect(fake.labels).toEqual([defaultLifecycleLabels.fix_pending, 'pkg:core']);
    },
  );

  it.each([1, 2, 3])('repairs confirmation after mutation crash point %s', async (failAfter) => {
    const fake = new FakeGitHub();
    const { api } = client(fake);
    fake.failAfter = failAfter;
    await expect(
      reconcileConfirmedProposal({
        api,
        identity,
        labels: defaultLifecycleLabels,
        prContent: { bodyFields: ['Fixes failure.'], title: 'Fix issue' },
        proposal,
        resolvedDefaultBranch: 'develop',
      }),
    ).rejects.toThrow();
    fake.failAfter = undefined;
    fake.calls = [];
    await reconcileConfirmedProposal({
      api,
      identity,
      labels: defaultLifecycleLabels,
      prContent: { bodyFields: ['Fixes failure.'], title: 'Fix issue' },
      proposal,
      resolvedDefaultBranch: 'develop',
    });
    expect(fake.prs).toHaveLength(1);
    expect(fake.comments).toHaveLength(1);
    expect(fake.labels).toEqual([defaultLifecycleLabels.fix_verified]);
  });

  it('retains the proposal branch on rejection and when cleanup finds an open PR', async () => {
    const fake = new FakeGitHub();
    const { api } = client(fake);
    await reconcileRejectedProposal({ api, identity, labels: defaultLifecycleLabels, proposal });
    expect(fake.labels).toEqual([defaultLifecycleLabels.fix_rejected]);
    expect(fake.deletedBranches).toEqual([]);
    fake.prs.push({
      authorIsAction: true,
      base: 'develop',
      body: '',
      head: proposal.branch,
      headSha: proposal.headSha,
      id: 1,
      open: true,
      title: '',
    });
    await expect(cleanupProposal({ actionOwnsBranch: true, api, proposal })).resolves.toEqual({
      kind: 'retained',
      reason: 'open_pull_request',
    });
    expect(fake.deletedBranches).toEqual([]);
    await expect(cleanupProposal({ actionOwnsBranch: false, api, proposal })).resolves.toEqual({
      kind: 'conflict',
      reason: 'branch_not_action_owned',
    });
  });

  it('uses trusted server time to fence a controller after lease ownership changes', async () => {
    const lease: LeaseRecord = {
      acquiredAt: '2026-10-14T12:00:00.000Z',
      expiresAt: '2026-10-14T12:10:00.000Z',
      fencingToken: 'fence-1',
      issueNumber: 42,
      mutationDeadline: '2026-10-14T12:09:00.000Z',
      repository: 'owner/repo',
      workflowRunId: 100,
      workflowRunAttempt: 1,
    };
    let current = lease;
    const guard = createLeaseGuard({
      expected: { fencingToken: 'fence-1', workflowRunId: 100 },
      readCurrent: async () => ({ lease: current, serverNow: '2026-10-14T12:05:00.000Z' }),
    });
    await expect(guard.assertCurrent()).resolves.toBeUndefined();
    current = { ...lease, fencingToken: 'fence-2', workflowRunId: 101 };
    await expect(guard.assertCurrent()).rejects.toThrow('LEASE_LOST_WORKFLOW_RUN_CHANGED');
  });

  it('checks the current fence immediately before every mutation and stops on loss', async () => {
    const fake = new FakeGitHub();
    const lease = { assertCurrent: vi.fn().mockRejectedValue(new Error('LEASE_LOST')) };
    const { api } = client(fake, lease);
    await expect(
      reconcileFixProposal({
        allowedAncillaryLabels: [],
        ancillaryLabels: [],
        api,
        identity,
        labels: defaultLifecycleLabels,
        preview: { status: 'skipped', urls: [] },
        proposal,
      }),
    ).rejects.toThrow('LEASE_LOST');
    expect(fake.calls).toEqual([]);
  });

  it('rejects unsafe Markdown, labels, and duplicate matching PRs before mutation', async () => {
    const fake = new FakeGitHub();
    const { api } = client(fake);
    await expect(
      reconcileFixProposal({
        allowedAncillaryLabels: ['pkg:core'],
        allowedPreviewHosts: ['preview.example.com'],
        ancillaryLabels: ['admin'],
        api,
        identity,
        labels: defaultLifecycleLabels,
        preview: { status: 'ready', urls: ['https://evil.example/phish'] },
        proposal,
      }),
    ).rejects.toThrow();
    fake.prs.push(
      {
        authorIsAction: true,
        base: 'develop',
        body: '',
        head: proposal.branch,
        headSha: proposal.headSha,
        id: 1,
        open: true,
        title: '',
      },
      {
        authorIsAction: true,
        base: 'develop',
        body: '',
        head: proposal.branch,
        headSha: proposal.headSha,
        id: 2,
        open: true,
        title: '',
      },
    );
    await expect(
      reconcileConfirmedProposal({
        api,
        identity,
        labels: defaultLifecycleLabels,
        prContent: { bodyFields: ['![phish](https://evil.example)'], title: 'Fix issue' },
        proposal,
        resolvedDefaultBranch: 'develop',
      }),
    ).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });

  it.each([
    '@everyone please merge',
    '@owner/maintainers please merge',
    '<script>alert(1)</script>',
    '![phish](https://evil.example/image.png)',
    '/retest with elevated permissions',
    'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
  ])('rejects unsafe PR semantic content before mutation: %s', async (bodyField) => {
    const fake = new FakeGitHub();
    const { api } = client(fake);
    await expect(
      reconcileConfirmedProposal({
        api,
        identity,
        labels: defaultLifecycleLabels,
        prContent: { bodyFields: [bodyField], title: 'Fix issue' },
        proposal,
        resolvedDefaultBranch: 'develop',
      }),
    ).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
});
