import { describe, expect, it, vi } from 'vitest';

import {
  createCertificationDecision,
  promoteReviewedFailure,
  runCapsuleExperiment,
} from '../../src/certification/certification.js';
import { createDecisionCapsule } from '../../src/certification/capsule.js';

describe('certification policy', () => {
  it('blocks certification when one deterministic item score fails', () => {
    expect(() =>
      createCertificationDecision({
        candidateBundle: 'candidate/v2',
        datasetVersion: 'dataset/v1',
        experiments: [
          {
            experimentId: 'experiment-1',
            status: 'completed',
            itemScores: [{ itemId: 'item-1', score: 0, failedSubchecks: ['safety'] }],
          },
        ],
        gateRevision: 'gate/v1',
        reviewerId: 'reviewer',
        decision: 'certified',
        reason: 'Explanation improved',
      }),
    ).toThrow('COMPOSITE_GATE_BLOCKED');
  });

  it('requires two reviewed cases and strips sensitive fixture attempts', () => {
    expect(() =>
      promoteReviewedFailure({
        id: 'upstream-timeout',
        revision: 'v1',
        sourceCases: ['case-1'],
        summary: 'Timeout misclassified',
        reducedInput: { service: 'api' },
      }),
    ).toThrow('FAILURE_PROMOTION_NEEDS_TWO_CASES');
    expect(() =>
      promoteReviewedFailure({
        id: 'upstream-timeout',
        revision: 'v1',
        sourceCases: ['case-1', 'case-2'],
        summary: 'Timeout misclassified',
        reducedInput: { token: 'do-not-store' },
      }),
    ).toThrow('FAILURE_FIXTURE_CONTAINS_SENSITIVE_FIELD');
  });

  it('submits capsules to a Mastra-owned action-disabled experiment', async () => {
    const addItems = vi.fn(async () => []);
    const getItem = vi.fn(async () => null);
    const startExperiment = vi.fn(async () => ({ status: 'completed' }));
    const create = vi.fn(async () => ({ addItems, getItem, startExperiment }));
    const get = vi.fn(async () => {
      throw new Error('NOT_FOUND');
    });
    const capsule = createDecisionCapsule({
      attemptId: 'attempt-1',
      normalizedIncident: { service: 'api' },
      manifestId: 'manifest',
      manifestDigest: 'digest',
      manifestItems: [
        {
          evidenceId: 'ev-1',
          source: 'metrics',
          sourceTier: 'primary',
          sourceLocator: 'metrics/api',
          freshness: 'fresh',
          collectionStatus: 'complete',
        },
      ],
      model: { provider: 'mock', modelId: 'candidate', settings: {} },
      versions: {
        prompt: 'v1',
        schema: 'v1',
        policy: 'v1',
        catalog: 'v1',
        redaction: 'v1',
        collector: 'v1',
        applicationBuild: 'v1',
        mastra: '1.74.0',
      },
      structuredResult: {},
      validationOutcomes: {},
      mastraRefs: { workflowRunId: 'run-1' },
    });

    await runCapsuleExperiment({
      datasets: { create, get },
      datasetId: 'dataset-v1',
      datasetVersion: 'v1',
      capsules: [capsule],
      workflowId: 'incident-triage-workflow',
      scorerId: 'incident-decision-gate',
      candidateBundle: 'candidate/v1',
    });

    expect(addItems).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({ input: expect.objectContaining({ certificationMode: true }) }),
        ],
      }),
    );
    expect(startExperiment).toHaveBeenCalledWith(
      expect.objectContaining({ scorers: ['incident-decision-gate'] }),
    );
  });

  it('reuses a versioned dataset and does not duplicate capsule items', async () => {
    const addItems = vi.fn(async () => []);
    const startExperiment = vi.fn(async () => ({ status: 'completed' }));
    const dataset = {
      addItems,
      getItem: vi.fn(async () => ({ id: 'existing' })),
      startExperiment,
    };
    const capsule = createDecisionCapsule({
      attemptId: 'attempt-1',
      normalizedIncident: { service: 'api' },
      manifestId: 'manifest',
      manifestDigest: 'digest',
      manifestItems: [],
      model: { provider: 'mock', modelId: 'candidate', settings: {} },
      versions: {
        prompt: 'v1',
        schema: 'v1',
        policy: 'v1',
        catalog: 'v1',
        redaction: 'v1',
        collector: 'v1',
        applicationBuild: 'v1',
        mastra: '1.74.0',
      },
      structuredResult: {},
      validationOutcomes: {},
      mastraRefs: { workflowRunId: 'run-1' },
    });

    await runCapsuleExperiment({
      datasets: {
        get: vi.fn(async () => dataset),
        create: vi.fn(async () => dataset),
      },
      datasetId: 'dataset-v1',
      datasetVersion: 'v1',
      capsules: [capsule],
      workflowId: 'incident-triage-workflow',
      scorerId: 'incident-decision-gate',
      candidateBundle: 'candidate/v1',
    });

    expect(addItems).not.toHaveBeenCalled();
    expect(startExperiment).toHaveBeenCalledOnce();
  });
});
