import { randomUUID } from 'node:crypto';

import type { DecisionCapsule } from './capsule.js';

export interface ExperimentGateResult {
  experimentId: string;
  status: 'completed' | 'failed' | 'running' | 'pending';
  itemScores: { itemId: string; score: number; failedSubchecks: string[] }[];
}

export interface CertificationDecision {
  id: string;
  candidateBundle: string;
  datasetVersion: string;
  experimentIds: string[];
  gateRevision: string;
  scoreRule: 'all_items_equal_1';
  reviewerId: string;
  decision: 'certified' | 'rejected';
  reason: string;
  decidedAt: string;
}

export function createCertificationDecision(input: {
  candidateBundle: string;
  datasetVersion: string;
  experiments: ExperimentGateResult[];
  gateRevision: string;
  reviewerId: string;
  decision: 'certified' | 'rejected';
  reason: string;
  now?: Date;
}): CertificationDecision {
  if (!input.reviewerId.trim() || !input.reason.trim())
    throw new Error('REVIEWER_DECISION_REQUIRED');
  if (
    input.experiments.length === 0 ||
    input.experiments.some((run) => run.status !== 'completed')
  ) {
    throw new Error('EXPERIMENTS_INCOMPLETE');
  }
  const failed = input.experiments
    .flatMap((run) => run.itemScores)
    .some((item) => item.score !== 1);
  if (input.decision === 'certified' && failed) throw new Error('COMPOSITE_GATE_BLOCKED');
  return {
    id: randomUUID(),
    candidateBundle: input.candidateBundle,
    datasetVersion: input.datasetVersion,
    experimentIds: input.experiments.map((run) => run.experimentId),
    gateRevision: input.gateRevision,
    scoreRule: 'all_items_equal_1',
    reviewerId: input.reviewerId,
    decision: input.decision,
    reason: input.reason.trim(),
    decidedAt: (input.now ?? new Date()).toISOString(),
  };
}

export function promoteReviewedFailure(input: {
  id: string;
  revision: string;
  sourceCases: string[];
  summary: string;
  reducedInput: Record<string, unknown>;
}): {
  id: string;
  revision: string;
  sourceCaseCount: number;
  summary: string;
  reducedInput: Record<string, unknown>;
} {
  const sourceCases = new Set(input.sourceCases);
  if (sourceCases.size < 2) throw new Error('FAILURE_PROMOTION_NEEDS_TWO_CASES');
  const serialized = JSON.stringify(input.reducedInput);
  if (/(password|secret|token|authorization|cookie|credential)/iu.test(serialized)) {
    throw new Error('FAILURE_FIXTURE_CONTAINS_SENSITIVE_FIELD');
  }
  return {
    id: input.id,
    revision: input.revision,
    sourceCaseCount: sourceCases.size,
    summary: input.summary,
    reducedInput: structuredClone(input.reducedInput),
  };
}

export interface MastraDatasetCoordinator {
  get(input: { id: string }): Promise<MastraDataset>;
  create(input: {
    id?: string;
    name: string;
    description?: string;
    targetType?: 'workflow';
    targetIds?: string[];
    scorerIds?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<MastraDataset>;
}

interface MastraDataset {
  getItem(input: { itemId: string }): Promise<unknown | null>;
  addItems(input: {
    items: { id: string; input: unknown; metadata?: Record<string, unknown> }[];
  }): Promise<unknown>;
  startExperiment(input: {
    name: string;
    targetType: 'workflow';
    targetId: string;
    scorers: string[];
  }): Promise<unknown>;
}

export async function runCapsuleExperiment(input: {
  datasets: MastraDatasetCoordinator;
  datasetId: string;
  datasetVersion: string;
  capsules: DecisionCapsule[];
  workflowId: string;
  scorerId: string;
  candidateBundle: string;
}): Promise<unknown> {
  let dataset: MastraDataset;
  try {
    dataset = await input.datasets.get({ id: input.datasetId });
  } catch {
    dataset = await input.datasets.create({
      id: input.datasetId,
      name: `Incident triage ${input.datasetVersion}`,
      description: 'Redacted, action-disabled incident decision capsules.',
      targetType: 'workflow',
      targetIds: [input.workflowId],
      scorerIds: [input.scorerId],
      metadata: { datasetVersion: input.datasetVersion },
    });
  }
  const existingItems = await Promise.all(
    input.capsules.map((capsule) => dataset.getItem({ itemId: capsule.id })),
  );
  const missingCapsules = input.capsules.filter((_, index) => !existingItems[index]);
  if (missingCapsules.length > 0) {
    await dataset.addItems({
      items: missingCapsules.map((capsule) => ({
        id: capsule.id,
        input: {
          attemptId: capsule.attemptId,
          incident: capsule.normalizedIncident,
          manifest: {
            id: capsule.manifestId,
            attemptId: capsule.attemptId,
            digest: capsule.manifestDigest,
            items: capsule.manifestItems,
            sealedAt: capsule.createdAt,
          },
          certificationMode: true,
        },
        metadata: { capsuleId: capsule.id },
      })),
    });
  }
  return dataset.startExperiment({
    name: input.candidateBundle,
    targetType: 'workflow',
    targetId: input.workflowId,
    scorers: [input.scorerId],
  });
}
