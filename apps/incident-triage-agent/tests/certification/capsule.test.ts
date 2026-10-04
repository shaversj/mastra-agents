import { describe, expect, it } from 'vitest';

import {
  createDecisionCapsule,
  type DecisionCapsuleInput,
} from '../../src/certification/capsule.js';

const input: DecisionCapsuleInput = {
  attemptId: 'attempt-1',
  normalizedIncident: { service: 'api', summary: 'errors' },
  manifestId: 'manifest-1',
  manifestDigest: 'digest',
  manifestItems: [],
  model: { provider: 'openai', modelId: 'gpt-test', settings: { temperature: 0 } },
  versions: {
    prompt: 'prompt/v1',
    schema: 'schema/v1',
    policy: 'policy/v1',
    catalog: 'catalog/v1',
    redaction: 'redaction/v1',
    collector: 'collector/v1',
    applicationBuild: 'build/v1',
    mastra: '1.74.0',
  },
  structuredResult: { nextAction: 'continue_monitoring' },
  validationOutcomes: { schema: true, grounding: true },
  mastraRefs: { workflowRunId: 'run-1' },
};

describe('decision capsules', () => {
  it('uses a stable identity for identical attributed inputs and versions', () => {
    const first = createDecisionCapsule(input, new Date('2026-01-01'));
    const second = createDecisionCapsule(input, new Date('2026-02-01'));

    expect(second.id).toBe(first.id);
    expect(second.createdAt).not.toBe(first.createdAt);
  });

  it('changes identity when a decision-producing version changes', () => {
    const first = createDecisionCapsule(input);
    const second = createDecisionCapsule({
      ...input,
      versions: { ...input.versions, policy: 'policy/v2' },
    });
    expect(second.id).not.toBe(first.id);
  });
});
