import { describe, expect, it } from 'vitest';

import {
  evaluateTriageReleaseGate,
  triageReleaseGate,
} from '../src/mastra/scorers/triage-release-gate.js';

const input = {
  event: {
    action: 'opened' as const,
    actorAssociation: 'NONE' as const,
    actorLogin: 'reporter',
    eventFingerprint: 'event-1',
    issueAuthorLogin: 'reporter',
    trustedActivation: false,
    trustedReset: false,
  },
  policy: {
    activationPolicy: 'automatic-public' as const,
    allowDownstreamWorkflows: false,
    publicationTokenKind: 'github-token' as const,
    safeDownstreamCi: false,
  },
  prior: { generation: 0, state: 'needs_triage' as const },
  repository: {
    baseSha: 'a'.repeat(40),
    defaultBranch: 'main',
    fullName: 'owner/repo',
    issueNumber: 42,
    observedProposalHeadSha: 'b'.repeat(40),
    visibility: 'public' as const,
  },
};

const output = {
  actor: { association: 'NONE' as const, login: 'reporter' },
  defaultBranchWritten: false,
  eventFingerprint: 'event-1',
  evidence: [
    { kind: 'diff' as const, source: 'trusted-sandbox' as const, status: 'observed' as const },
    { kind: 'test' as const, source: 'trusted-sandbox' as const, status: 'passed' as const },
  ],
  generation: 1,
  merged: false,
  modelInvoked: true,
  mutations: [
    {
      idempotencyKey: 'branch:event-1',
      kind: 'branch_push' as const,
      ref: 'triagebot/fix-42',
      sha: 'b'.repeat(40),
    },
    { idempotencyKey: 'comment:event-1', kind: 'comment' as const },
  ],
  proposal: {
    baseSha: 'a'.repeat(40),
    branch: 'triagebot/fix-42',
    headSha: 'b'.repeat(40),
  },
  publicationTriggersDownstreamWorkflows: false,
  route: 'triage' as const,
  state: 'fix_pending' as const,
};

describe('triage release gate', () => {
  it('scores a fully attributed, non-merging proposal as one', async () => {
    expect(evaluateTriageReleaseGate(input, output)).toEqual([]);
    const result = await triageReleaseGate.run({ input, output });
    expect(result.analyzeStepResult).toEqual({ failures: [] });
    expect(result.score).toBe(1);
    expect(result.reason).toContain('triage-release-gate/v1: passed');
  });

  it.each([
    ['schema', input, { nope: true }],
    [
      'visibility',
      { ...input, repository: { ...input.repository, visibility: 'private' } },
      output,
    ],
    ['activation', { ...input, policy: { ...input.policy, activationPolicy: 'trusted' } }, output],
    ['generation', input, { ...output, generation: 2 }],
    [
      'transition',
      {
        ...input,
        event: { ...input.event, action: 'comment' },
        prior: { generation: 1, state: 'fix_verified' },
      },
      output,
    ],
    [
      'evidence_provenance',
      input,
      {
        ...output,
        evidence: output.evidence.map((item, index) =>
          index === 0 ? { ...item, source: 'model' } : item,
        ),
      },
    ],
    [
      'actor_sha_binding',
      input,
      { ...output, proposal: { ...output.proposal, headSha: 'c'.repeat(40) } },
    ],
    [
      'branch_scope',
      input,
      {
        ...output,
        mutations: output.mutations.map((item, index) =>
          index === 0 ? { ...item, ref: 'feature/not-owned' } : item,
        ),
        proposal: { ...output.proposal, branch: 'feature/not-owned' },
      },
    ],
    [
      'idempotency',
      input,
      {
        ...output,
        mutations: [
          output.mutations[0],
          { ...output.mutations[1], idempotencyKey: 'branch:event-1' },
        ],
      },
    ],
    ['no_merge_or_default_write', input, { ...output, merged: true }],
    [
      'publication_policy',
      {
        ...input,
        policy: { ...input.policy, publicationTokenKind: 'workflow-triggering' },
      },
      { ...output, publicationTriggersDownstreamWorkflows: true },
    ],
  ])('returns the exact %s failure code', (failure, gateInput, gateOutput) => {
    expect(evaluateTriageReleaseGate(gateInput, gateOutput)).toEqual([failure]);
  });
});
