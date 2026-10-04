import { describe, expect, it } from 'vitest';

import { validateDecision } from '../src/decision/validate.js';
import { applyMitigationPolicy } from '../src/mitigation/policy.js';

const manifest = {
  id: 'manifest-1',
  attemptId: 'attempt-1',
  digest: 'digest',
  sealedAt: '2026-10-03T18:00:00.000Z',
  items: [
    {
      evidenceId: 'ev-known',
      source: 'metrics',
      sourceTier: 'primary' as const,
      sourceLocator: 'metrics/api',
      freshness: 'fresh' as const,
      collectionStatus: 'complete' as const,
    },
  ],
};

const validDecision = {
  incidentClass: 'bad_deploy' as const,
  nextAction: 'rollback_release' as const,
  evidenceCitations: ['ev-known'],
  confidence: 0.9,
  caveats: [],
  hypotheses: ['The latest release introduced failures'],
  rationale: 'The error increase aligns with the deployment.',
  verificationPlan: ['Compare error rate after a simulated rollback window'],
};

describe('bounded decision contract', () => {
  it('rejects unknown citations and taxonomy values before policy', () => {
    expect(() =>
      validateDecision({ ...validDecision, evidenceCitations: ['ev-unknown'] }, manifest),
    ).toThrow('UNKNOWN_EVIDENCE_CITATION');
    expect(() =>
      validateDecision({ ...validDecision, nextAction: 'restart_everything' }, manifest),
    ).toThrow();
  });

  it('requires approval but never executes mutation-sensitive actions', () => {
    expect(applyMitigationPolicy(validDecision)).toEqual({
      disposition: 'approval_pending',
      requiresApproval: true,
      executed: false,
      catalogAction: 'rollback_release',
    });
  });
});
