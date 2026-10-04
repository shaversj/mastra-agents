import type { Pool } from 'pg';

import type { CertificationDecision } from '../../certification/certification.js';
import type { DecisionCapsule } from '../../certification/capsule.js';

export class PgCertificationRepository {
  constructor(private readonly pool: Pool) {}

  async saveCapsule(capsule: DecisionCapsule): Promise<void> {
    await this.pool.query(
      `INSERT INTO incident_decision_capsules
        (id, attempt_id, capsule, manifest_digest, mastra_workflow_run_id,
         mastra_gate_result_id, retention_class, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [
        capsule.id,
        capsule.attemptId,
        JSON.stringify(capsule),
        capsule.manifestDigest,
        capsule.mastraRefs.workflowRunId,
        capsule.mastraRefs.gateResultId ?? null,
        capsule.retentionClass,
        capsule.createdAt,
      ],
    );
  }

  async saveDecision(decision: CertificationDecision): Promise<void> {
    await this.pool.query(
      `INSERT INTO incident_certification_decisions
        (id, candidate_bundle, dataset_version, experiment_ids, gate_revision,
         score_rule, reviewer_id, decision, reason, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        decision.id,
        decision.candidateBundle,
        decision.datasetVersion,
        JSON.stringify(decision.experimentIds),
        decision.gateRevision,
        decision.scoreRule,
        decision.reviewerId,
        decision.decision,
        decision.reason,
        decision.decidedAt,
      ],
    );
  }
}
