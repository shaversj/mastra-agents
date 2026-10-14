import { describe, expect, it } from 'vitest';

import {
  decideLeaseAcquisition,
  assertLeaseIdentity,
  decideLeaseRelease,
  leaseRefForIssue,
  verifyLeaseOwnership,
  type LeaseRecord,
} from '../src/github/lease.js';

const current: LeaseRecord = {
  acquiredAt: '2026-10-14T12:00:00.000Z',
  expiresAt: '2026-10-14T12:10:00.000Z',
  fencingToken: 'fence-1',
  issueNumber: 42,
  mutationDeadline: '2026-10-14T12:09:00.000Z',
  repository: 'example/widgets',
  workflowRunId: 100,
  workflowRunAttempt: 1,
};

describe('per-issue lease decisions', () => {
  it('uses a dedicated repository-and-issue lease ref', () => {
    expect(leaseRefForIssue(1001, 42)).toBe('refs/triage-agent/leases/1001/42');
  });

  it('acquires an empty lease and rejects malformed immutable deadlines', () => {
    expect(
      decideLeaseAcquisition({
        candidate: current,
        current: null,
        serverNow: '2026-10-14T12:00:00.000Z',
      }),
    ).toEqual({ kind: 'acquired', lease: current });
    expect(() =>
      decideLeaseAcquisition({
        candidate: { ...current, mutationDeadline: current.expiresAt },
        current: null,
        serverNow: '2026-10-14T12:00:00.000Z',
      }),
    ).toThrowError('LEASE_DEADLINE_INVALID');
  });

  it('rejects lease records with invalid repository or issue identity', () => {
    expect(() =>
      decideLeaseAcquisition({
        candidate: { ...current, issueNumber: 0 },
        current: null,
        serverNow: '2026-10-14T12:00:00.000Z',
      }),
    ).toThrowError('LEASE_ISSUE_INVALID');
    expect(() =>
      decideLeaseAcquisition({
        candidate: { ...current, repository: 'missing-owner' },
        current: null,
        serverNow: '2026-10-14T12:00:00.000Z',
      }),
    ).toThrowError('LEASE_REPOSITORY_INVALID');
  });

  it('returns contention while the current run can still mutate', () => {
    expect(
      decideLeaseAcquisition({
        candidate: { ...current, fencingToken: 'fence-2', workflowRunId: 101 },
        current,
        maxApiTimeoutMs: 30_000,
        priorRunStatus: 'in_progress',
        serverNow: '2026-10-14T12:08:00.000Z',
        toleratedClockSkewMs: 5_000,
      }),
    ).toEqual({ kind: 'contended', ownerWorkflowRunId: 100 });
  });

  it('does not let the current owner extend immutable deadlines', () => {
    expect(
      decideLeaseAcquisition({
        candidate: {
          ...current,
          expiresAt: '2026-10-14T12:20:00.000Z',
          mutationDeadline: '2026-10-14T12:19:00.000Z',
        },
        current,
        serverNow: '2026-10-14T12:05:00.000Z',
      }),
    ).toEqual({ kind: 'already_owned', lease: current });
  });

  it('allows stale takeover only after terminal status and timeout/skew grace', () => {
    const candidate = {
      ...current,
      acquiredAt: '2026-10-14T12:10:35.000Z',
      expiresAt: '2026-10-14T12:21:00.000Z',
      fencingToken: 'fence-2',
      mutationDeadline: '2026-10-14T12:20:00.000Z',
      workflowRunId: 101,
    };
    const options = {
      candidate,
      current,
      maxApiTimeoutMs: 30_000,
      priorRunStatus: 'completed' as const,
      toleratedClockSkewMs: 5_000,
    };

    expect(decideLeaseAcquisition({ ...options, serverNow: '2026-10-14T12:10:34.999Z' })).toEqual({
      kind: 'takeover_pending',
      eligibleAt: '2026-10-14T12:10:35.000Z',
    });
    expect(decideLeaseAcquisition({ ...options, serverNow: '2026-10-14T12:10:35.000Z' })).toEqual({
      kind: 'taken_over',
      lease: candidate,
      previousFencingToken: 'fence-1',
    });
  });

  it('does not allow a nonterminal prior run to be taken over after expiry', () => {
    expect(
      decideLeaseAcquisition({
        candidate: {
          ...current,
          acquiredAt: '2026-10-14T12:20:00.000Z',
          expiresAt: '2026-10-14T12:30:00.000Z',
          fencingToken: 'fence-2',
          mutationDeadline: '2026-10-14T12:29:00.000Z',
          workflowRunId: 101,
        },
        current,
        maxApiTimeoutMs: 30_000,
        priorRunStatus: 'in_progress',
        serverNow: '2026-10-14T12:20:00.000Z',
        toleratedClockSkewMs: 5_000,
      }),
    ).toEqual({ kind: 'contended', ownerWorkflowRunId: 100 });
  });

  it('does not share a fence across attempts of the same workflow run', () => {
    expect(
      decideLeaseAcquisition({
        candidate: { ...current, fencingToken: 'fence-2', workflowRunAttempt: 2 },
        current,
        priorRunStatus: 'in_progress',
        serverNow: '2026-10-14T12:01:00.000Z',
      }),
    ).toEqual({ kind: 'contended', ownerWorkflowRunId: 100 });
  });

  it('fails closed for old or cross-issue lease records', () => {
    expect(() =>
      assertLeaseIdentity({ ...current, workflowRunAttempt: undefined } as unknown as LeaseRecord, {
        issueNumber: 42,
        repository: 'example/widgets',
      }),
    ).toThrowError('LEASE_WORKFLOW_ATTEMPT_INVALID');
    expect(() =>
      assertLeaseIdentity(current, { issueNumber: 43, repository: 'example/widgets' }),
    ).toThrowError('LEASE_IDENTITY_MISMATCH');
  });

  it('detects lost ownership and the immutable mutation deadline', () => {
    expect(
      verifyLeaseOwnership(current, {
        fencingToken: 'fence-old',
        serverNow: '2026-10-14T12:05:00.000Z',
        workflowRunId: 100,
      }),
    ).toEqual({ kind: 'lost', reason: 'fencing_token_changed' });
    expect(
      verifyLeaseOwnership(current, {
        fencingToken: 'fence-1',
        serverNow: current.mutationDeadline,
        workflowRunId: 100,
      }),
    ).toEqual({ kind: 'lost', reason: 'mutation_deadline_reached' });
    expect(
      verifyLeaseOwnership(current, {
        fencingToken: 'fence-1',
        serverNow: '2026-10-14T12:08:59.999Z',
        workflowRunId: 100,
      }),
    ).toEqual({ kind: 'current', lease: current });
  });

  it('releases only with the current workflow and fencing token', () => {
    expect(decideLeaseRelease(current, { fencingToken: 'fence-old', workflowRunId: 100 })).toEqual({
      kind: 'lost',
      reason: 'fencing_token_changed',
    });
    expect(decideLeaseRelease(current, { fencingToken: 'fence-1', workflowRunId: 100 })).toEqual({
      kind: 'release',
      lease: current,
    });
  });
});
