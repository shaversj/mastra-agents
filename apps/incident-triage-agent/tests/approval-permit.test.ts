import { describe, expect, it } from 'vitest';

import { createPermit } from '../src/approvals/permit.js';
import type { PermitBinding } from '../src/domain/approval.js';
import { InMemoryApprovalRepository } from '../src/persistence/repositories/approval-repository.js';

const binding: PermitBinding = {
  caseId: 'case-1',
  attemptId: 'attempt-1',
  mastraRunId: 'run-1',
  suspendedStep: 'governed-approval',
  manifestDigest: 'manifest-digest',
  decisionDigest: 'decision-digest',
  stagedParametersDigest: 'parameters-digest',
  verificationPlanDigest: 'verification-digest',
  buildVersion: 'build/v1',
  promptVersion: 'prompt/v1',
  schemaVersion: 'decision/v1',
  policyVersion: 'policy/v1',
  catalogVersion: 'catalog/v1',
  collectorVersion: 'collector/v1',
  redactionVersion: 'redaction/v1',
};

describe('approval permit', () => {
  it('atomically allows one of two concurrent decisions to consume and enqueue resume', async () => {
    const repository = new InMemoryApprovalRepository();
    const permit = createPermit({
      binding,
      eligibleRoles: ['incident-approver'],
      now: new Date('2026-10-03T18:00:00Z'),
      expiresAt: new Date('2026-10-03T19:00:00Z'),
    });
    await repository.insert(permit);
    const decide = () =>
      repository.consume({
        permitId: permit.id,
        actorId: 'approver-1',
        actorRoles: ['incident-approver'],
        decision: 'approved',
        reason: 'Validated the evidence and simulation plan',
        expectedBinding: binding,
        now: new Date('2026-10-03T18:30:00Z'),
      });

    const outcomes = await Promise.allSettled([decide(), decide()]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(repository.snapshot().resumePermitIds).toEqual([permit.id]);
  });

  it.each([
    ['wrong role', { actorRoles: ['incident-operator'] }, 'PERMIT_FORBIDDEN'],
    ['empty reason', { reason: '   ' }, 'APPROVAL_REASON_REQUIRED'],
    [
      'changed policy',
      { expectedBinding: { ...binding, policyVersion: 'policy/v2' } },
      'PERMIT_STALE',
    ],
    ['expired permit', { now: new Date('2026-10-03T20:00:00Z') }, 'PERMIT_EXPIRED'],
  ])('rejects %s without a resume request', async (_name, override, reasonCode) => {
    const repository = new InMemoryApprovalRepository();
    const permit = createPermit({
      binding,
      eligibleRoles: ['incident-approver'],
      now: new Date('2026-10-03T18:00:00Z'),
      expiresAt: new Date('2026-10-03T19:00:00Z'),
    });
    await repository.insert(permit);

    await expect(
      repository.consume({
        permitId: permit.id,
        actorId: 'approver-1',
        actorRoles: ['incident-approver'],
        decision: 'approved',
        reason: 'Reviewed',
        expectedBinding: binding,
        now: new Date('2026-10-03T18:30:00Z'),
        ...override,
      }),
    ).rejects.toThrow(reasonCode);
    expect(repository.snapshot().resumePermitIds).toHaveLength(0);
  });
});
