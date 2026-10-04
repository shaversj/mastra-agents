import { describe, expect, it } from 'vitest';

import {
  evaluateDecisionGate,
  incidentDecisionGate,
} from '../../src/mastra/scorers/incident-decision-gate.js';

const input = {
  attemptId: 'attempt-1',
  incident: { service: 'api' },
  certificationMode: true,
  manifest: {
    id: 'manifest-1',
    attemptId: 'attempt-1',
    digest: 'digest',
    sealedAt: '2026-10-03T18:00:00.000Z',
    items: [
      {
        evidenceId: 'ev-1',
        source: 'metrics',
        sourceTier: 'primary' as const,
        sourceLocator: 'metrics/api',
        freshness: 'fresh' as const,
        collectionStatus: 'complete' as const,
      },
    ],
  },
};

const output = {
  attemptId: 'attempt-1',
  manifestDigest: 'digest',
  certificationMode: true,
  decision: {
    incidentClass: 'dependency_outage' as const,
    nextAction: 'escalate_owner' as const,
    evidenceCitations: ['ev-1'],
    confidence: 0.9,
    caveats: [],
    hypotheses: ['Dependency errors align with the incident'],
    rationale: 'Primary metrics show dependency failures.',
    verificationPlan: ['Verify dependency recovery'],
  },
  policy: {
    disposition: 'completed' as const,
    requiresApproval: false,
    executed: false,
    catalogAction: 'escalate_owner' as const,
  },
  outcome: { kind: 'advisory' as const, executed: false },
};

describe('incident decision composite gate', () => {
  it('scores a fully valid attributed outcome as one', async () => {
    expect(evaluateDecisionGate(input, output)).toEqual([]);
    const result = await incidentDecisionGate.run({ input, output });
    expect(result.score).toBe(1);
    expect(result.reason).toContain('passed');
  });

  it.each([
    ['schema', input, { nope: true }],
    [
      'grounding',
      input,
      { ...output, decision: { ...output.decision, evidenceCitations: ['ev-unknown'] } },
    ],
    [
      'provenance',
      {
        ...input,
        manifest: {
          ...input.manifest,
          items: [{ ...input.manifest.items[0], sourceTier: 'secondary' }],
        },
      },
      output,
    ],
    ['safety', input, { ...output, decision: { ...output.decision, nextAction: 'scale_service' } }],
    ['governance', input, { ...output, policy: { ...output.policy, requiresApproval: true } }],
    ['non_execution', input, { ...output, outcome: { kind: 'advisory', executed: true } }],
  ])('names the %s failed subcheck', (failure, gateInput, gateOutput) => {
    expect(evaluateDecisionGate(gateInput, gateOutput)).toContain(failure);
  });
});
