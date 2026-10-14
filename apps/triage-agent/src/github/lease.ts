export interface LeaseRecord {
  acquiredAt: string;
  expiresAt: string;
  fencingToken: string;
  issueNumber: number;
  mutationDeadline: string;
  repository: string;
  workflowRunId: number;
}

export type WorkflowRunStatus =
  | 'cancelled'
  | 'completed'
  | 'failure'
  | 'in_progress'
  | 'queued'
  | 'skipped'
  | 'timed_out'
  | 'unknown';

export function leaseRefForIssue(repositoryId: number, issueNumber: number): string {
  if (!Number.isInteger(repositoryId) || repositoryId <= 0)
    throw new Error('LEASE_REPOSITORY_INVALID');
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('LEASE_ISSUE_INVALID');
  return `refs/triage-agent/leases/${repositoryId}/${issueNumber}`;
}

export type LeaseAcquisitionDecision =
  | { kind: 'acquired'; lease: LeaseRecord }
  | { kind: 'already_owned'; lease: LeaseRecord }
  | { kind: 'contended'; ownerWorkflowRunId: number }
  | { eligibleAt: string; kind: 'takeover_pending' }
  | { kind: 'taken_over'; lease: LeaseRecord; previousFencingToken: string };

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`LEASE_${field}_INVALID`);
  return parsed;
}

function validateLease(lease: LeaseRecord): void {
  const acquiredAt = timestamp(lease.acquiredAt, 'ACQUIRED_AT');
  const mutationDeadline = timestamp(lease.mutationDeadline, 'DEADLINE');
  const expiresAt = timestamp(lease.expiresAt, 'EXPIRY');
  if (acquiredAt > mutationDeadline || mutationDeadline >= expiresAt) {
    throw new Error('LEASE_DEADLINE_INVALID');
  }
  if (!lease.fencingToken || lease.fencingToken.length > 200) {
    throw new Error('LEASE_FENCING_TOKEN_INVALID');
  }
  if (!Number.isInteger(lease.workflowRunId) || lease.workflowRunId <= 0) {
    throw new Error('LEASE_WORKFLOW_RUN_INVALID');
  }
  if (!Number.isInteger(lease.issueNumber) || lease.issueNumber <= 0) {
    throw new Error('LEASE_ISSUE_INVALID');
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(lease.repository)) {
    throw new Error('LEASE_REPOSITORY_INVALID');
  }
}

const terminalStatuses = new Set<WorkflowRunStatus>([
  'cancelled',
  'completed',
  'failure',
  'skipped',
  'timed_out',
]);

export function decideLeaseAcquisition(input: {
  candidate: LeaseRecord;
  current: LeaseRecord | null;
  maxApiTimeoutMs?: number;
  priorRunStatus?: WorkflowRunStatus;
  serverNow: string;
  toleratedClockSkewMs?: number;
}): LeaseAcquisitionDecision {
  validateLease(input.candidate);
  const now = timestamp(input.serverNow, 'SERVER_TIME');
  const candidateAcquiredAt = timestamp(input.candidate.acquiredAt, 'ACQUIRED_AT');
  if (!input.current) {
    if (candidateAcquiredAt > now) throw new Error('LEASE_ACQUIRED_IN_FUTURE');
    return { kind: 'acquired', lease: input.candidate };
  }
  validateLease(input.current);
  if (
    input.current.workflowRunId === input.candidate.workflowRunId &&
    input.current.fencingToken === input.candidate.fencingToken
  ) {
    return { kind: 'already_owned', lease: input.current };
  }

  const terminal = input.priorRunStatus && terminalStatuses.has(input.priorRunStatus);
  if (!terminal) return { kind: 'contended', ownerWorkflowRunId: input.current.workflowRunId };

  const maxApiTimeoutMs = input.maxApiTimeoutMs ?? 0;
  const toleratedClockSkewMs = input.toleratedClockSkewMs ?? 0;
  if (maxApiTimeoutMs < 0 || toleratedClockSkewMs < 0) throw new Error('LEASE_GRACE_INVALID');
  const takeoverAt =
    timestamp(input.current.expiresAt, 'EXPIRY') + maxApiTimeoutMs + toleratedClockSkewMs;
  if (now < takeoverAt) {
    return { eligibleAt: new Date(takeoverAt).toISOString(), kind: 'takeover_pending' };
  }
  if (candidateAcquiredAt > now) throw new Error('LEASE_ACQUIRED_IN_FUTURE');
  return {
    kind: 'taken_over',
    lease: input.candidate,
    previousFencingToken: input.current.fencingToken,
  };
}

export type LeaseOwnershipDecision =
  | { kind: 'current'; lease: LeaseRecord }
  | {
      kind: 'lost';
      reason: 'fencing_token_changed' | 'mutation_deadline_reached' | 'workflow_run_changed';
    };

export type LeaseReleaseDecision =
  | { kind: 'lost'; reason: 'fencing_token_changed' | 'workflow_run_changed' }
  | { kind: 'release'; lease: LeaseRecord };

export function decideLeaseRelease(
  current: LeaseRecord,
  expected: { fencingToken: string; workflowRunId: number },
): LeaseReleaseDecision {
  validateLease(current);
  if (current.workflowRunId !== expected.workflowRunId) {
    return { kind: 'lost', reason: 'workflow_run_changed' };
  }
  if (current.fencingToken !== expected.fencingToken) {
    return { kind: 'lost', reason: 'fencing_token_changed' };
  }
  return { kind: 'release', lease: current };
}

export function verifyLeaseOwnership(
  current: LeaseRecord,
  expected: { fencingToken: string; serverNow: string; workflowRunId: number },
): LeaseOwnershipDecision {
  const identity = decideLeaseRelease(current, expected);
  if (identity.kind === 'lost') return identity;
  if (
    timestamp(expected.serverNow, 'SERVER_TIME') >= timestamp(current.mutationDeadline, 'DEADLINE')
  ) {
    return { kind: 'lost', reason: 'mutation_deadline_reached' };
  }
  return { kind: 'current', lease: current };
}

export interface LeaseGuard {
  assertCurrent(): Promise<void>;
}

export function createLeaseGuard(input: {
  expected: { fencingToken: string; workflowRunId: number };
  readCurrent(): Promise<{ lease: LeaseRecord; serverNow: string }>;
}): LeaseGuard {
  return {
    async assertCurrent() {
      const current = await input.readCurrent();
      const ownership = verifyLeaseOwnership(current.lease, {
        ...input.expected,
        serverNow: current.serverNow,
      });
      if (ownership.kind === 'lost')
        throw new Error(`LEASE_LOST_${ownership.reason.toUpperCase()}`);
    },
  };
}
