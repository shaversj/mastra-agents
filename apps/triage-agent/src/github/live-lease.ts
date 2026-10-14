import { setTimeout as delay } from 'node:timers/promises';

import type { ProjectedGitHubEvent } from '../domain/event-projection.js';
import {
  assertLeaseIdentity,
  createLeaseGuard,
  decideLeaseAcquisition,
  leaseRefForIssue,
  type LeaseRecord,
} from './lease.js';
import type { GitHubRest } from './live-rest.js';

export interface LiveLease {
  assertCurrent(): Promise<void>;
  fencingToken: string;
  release(): Promise<void>;
}

export async function createLiveLease(
  api: GitHubRest,
  event: ProjectedGitHubEvent,
  workflowRunId: number,
  workflowRunAttempt: number,
  abortSignal?: AbortSignal,
  mayWaitForGrace = true,
): Promise<LiveLease> {
  const ref = leaseRefForIssue(event.repository.id, event.issue.number).replace(/^refs\//u, '');
  const read = async (): Promise<{
    lease: LeaseRecord;
    refSha: string;
    serverNow: string;
  } | null> => {
    try {
      const reference = await api.request<{ object: { sha: string } }>('GET', `/git/ref/${ref}`);
      const commit = await api.request<{ tree: { sha: string } }>(
        'GET',
        `/git/commits/${reference.data.object.sha}`,
      );
      const tree = await api.request<{ tree: Array<{ path: string; sha: string }> }>(
        'GET',
        `/git/trees/${commit.data.tree.sha}`,
      );
      const blobSha = tree.data.tree.find(({ path }) => path === 'lease.json')?.sha;
      if (!blobSha) throw new Error('LEASE_BLOB_MISSING');
      const blob = await api.request<{ content: string }>('GET', `/git/blobs/${blobSha}`);
      const lease = JSON.parse(
        Buffer.from(blob.data.content, 'base64').toString('utf8'),
      ) as LeaseRecord;
      assertLeaseIdentity(lease, {
        issueNumber: event.issue.number,
        repository: event.repository.fullName,
      });
      return {
        lease,
        refSha: reference.data.object.sha,
        serverNow: reference.date,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'GITHUB_API_404') return null;
      throw error;
    }
  };
  const current = await read();
  const serverNow = current?.serverNow ?? (await api.request('GET', '')).date;
  const priorRun =
    current && priorLeaseOwnerDiffers(current.lease, workflowRunId, workflowRunAttempt)
      ? await api.workflowRunStatus(current.lease.workflowRunId, current.lease.workflowRunAttempt)
      : undefined;
  const decisionServerNow = priorRun?.observedAt ?? serverNow;
  const now = Date.parse(decisionServerNow);
  const candidate: LeaseRecord =
    current?.lease.workflowRunId === workflowRunId &&
    current.lease.workflowRunAttempt === workflowRunAttempt
      ? current.lease
      : {
          acquiredAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 10 * 60_000).toISOString(),
          fencingToken: crypto.randomUUID(),
          issueNumber: event.issue.number,
          mutationDeadline: new Date(now + 9 * 60_000).toISOString(),
          repository: event.repository.fullName,
          workflowRunId,
          workflowRunAttempt,
        };
  const decision = decideLeaseAcquisition({
    candidate,
    current: current?.lease ?? null,
    maxApiTimeoutMs: 30_000,
    ...(priorRun
      ? {
          priorRunStatus: priorRun.status,
          ...(priorRun.terminalAt ? { priorRunTerminalAt: priorRun.terminalAt } : {}),
        }
      : {}),
    serverNow: decisionServerNow,
    toleratedClockSkewMs: 5_000,
  });
  if (decision.kind === 'takeover_pending' && mayWaitForGrace) {
    const waitMs = Math.max(
      0,
      Date.parse(decision.eligibleAt) - Date.parse(decisionServerNow) + 100,
    );
    // GitHub's Date header is second-granular, so permit one rounding second beyond the 35s grace.
    if (waitMs > 36_100) throw new Error('LEASE_GRACE_INVALID');
    await delay(waitMs, undefined, { ...(abortSignal ? { signal: abortSignal } : {}) });
    return createLiveLease(api, event, workflowRunId, workflowRunAttempt, abortSignal, false);
  }
  if (
    decision.kind !== 'acquired' &&
    decision.kind !== 'already_owned' &&
    decision.kind !== 'taken_over'
  ) {
    throw new Error('LEASE_CONTENDED');
  }
  const lease = decision.lease;
  if (decision.kind === 'acquired' || decision.kind === 'taken_over') {
    const blob = await api.request<{ sha: string }>('POST', '/git/blobs', {
      content: Buffer.from(JSON.stringify(lease)).toString('base64'),
      encoding: 'base64',
    });
    const tree = await api.request<{ sha: string }>('POST', '/git/trees', {
      tree: [{ mode: '100644', path: 'lease.json', sha: blob.data.sha, type: 'blob' }],
    });
    const commit = await api.request<{ sha: string }>('POST', '/git/commits', {
      message: `triage lease ${event.issue.number}`,
      parents: current ? [current.refSha] : [],
      tree: tree.data.sha,
    });
    try {
      if (decision.kind === 'acquired') {
        await api.request('POST', '/git/refs', { ref: `refs/${ref}`, sha: commit.data.sha });
      } else {
        await api.request('PATCH', `/git/refs/${ref}`, { force: false, sha: commit.data.sha });
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'GITHUB_API_422') {
        throw new Error('LEASE_CONTENDED', { cause: error });
      }
      throw error;
    }
  }
  const guard = createLeaseGuard({
    expected: { fencingToken: lease.fencingToken, workflowRunAttempt, workflowRunId },
    readCurrent: async () => {
      const value = await read();
      if (!value) throw new Error('LEASE_LOST_MISSING');
      return value;
    },
  });
  return {
    assertCurrent: () => guard.assertCurrent(),
    fencingToken: lease.fencingToken,
    async release() {
      // Retaining the terminal record avoids a racy delete. The next run takes it over with a
      // fast-forward compare-and-swap after GitHub reports this workflow terminal.
    },
  };
}

export function priorLeaseOwnerDiffers(
  current: Pick<LeaseRecord, 'workflowRunAttempt' | 'workflowRunId'>,
  workflowRunId: number,
  workflowRunAttempt: number,
): boolean {
  return (
    current.workflowRunId !== workflowRunId || current.workflowRunAttempt !== workflowRunAttempt
  );
}
