import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { assertPermitBinding } from '../../approvals/revalidate.js';
import type { BindingVersions } from '../../approvals/binding.js';
import type {
  ApprovalDecisionInput,
  ApprovalPermit,
  PermitBinding,
} from '../../domain/approval.js';

export class InMemoryApprovalRepository {
  private readonly permits = new Map<string, ApprovalPermit>();
  private readonly resumeRequests = new Set<string>();

  async insert(permit: ApprovalPermit): Promise<ApprovalPermit> {
    const existing = [...this.permits.values()].find(
      (candidate) =>
        candidate.mastraRunId === permit.mastraRunId &&
        candidate.suspendedStep === permit.suspendedStep &&
        candidate.decisionDigest === permit.decisionDigest,
    );
    if (existing) {
      assertPermitBinding(existing, permit);
      return structuredClone(existing);
    }
    for (const candidate of this.permits.values()) {
      if (candidate.attemptId === permit.attemptId && candidate.status === 'pending') {
        candidate.status = 'superseded';
      }
    }
    this.permits.set(permit.id, structuredClone(permit));
    return structuredClone(permit);
  }

  async consume(input: ApprovalDecisionInput): Promise<ApprovalPermit> {
    const permit = this.permits.get(input.permitId);
    if (!permit) throw new Error('PERMIT_NOT_FOUND');
    if (permit.status !== 'pending') throw new Error('PERMIT_CONFLICT');
    const now = input.now ?? new Date();
    if (permit.expiresAt <= now) {
      permit.status = 'expired';
      throw new Error('PERMIT_EXPIRED');
    }
    const actorRole = input.actorRoles.find((role) => permit.eligibleRoles.includes(role));
    if (!actorRole) throw new Error('PERMIT_FORBIDDEN');
    if (!input.reason.trim()) throw new Error('APPROVAL_REASON_REQUIRED');
    assertPermitBinding(permit, input.expectedBinding);

    permit.status = 'consumed';
    permit.consumedAt = now;
    permit.actorId = input.actorId;
    permit.actorRole = actorRole;
    permit.decision = input.decision;
    permit.reason = input.reason.trim();
    this.resumeRequests.add(permit.id);
    return structuredClone(permit);
  }

  snapshot(): { permits: ApprovalPermit[]; resumePermitIds: string[] } {
    return {
      permits: [...this.permits.values()].map((permit) => structuredClone(permit)),
      resumePermitIds: [...this.resumeRequests],
    };
  }
}

export class PgApprovalRepository {
  constructor(private readonly pool: Pool) {}

  async insert(permit: ApprovalPermit): Promise<ApprovalPermit> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<Record<string, unknown>>(
        `SELECT * FROM incident_approval_permits
         WHERE mastra_run_id = $1 AND suspended_step = $2 AND decision_digest = $3
         FOR UPDATE`,
        [permit.mastraRunId, permit.suspendedStep, permit.decisionDigest],
      );
      const existingPermit = rowToPermit(existing.rows[0]);
      if (existingPermit) {
        assertPermitBinding(existingPermit, permit);
        await client.query('COMMIT');
        return existingPermit;
      }
      await client.query(
        `UPDATE incident_approval_permits SET status = 'superseded'
         WHERE attempt_id = $1 AND status = 'pending'`,
        [permit.attemptId],
      );
      await client.query(
        `INSERT INTO incident_workflow_artifacts
          (attempt_id, case_id, mastra_run_id, suspended_step, decision_digest,
           staged_parameters_digest, verification_plan_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (attempt_id) DO UPDATE SET
           case_id = EXCLUDED.case_id,
           mastra_run_id = EXCLUDED.mastra_run_id,
           suspended_step = EXCLUDED.suspended_step,
           decision_digest = EXCLUDED.decision_digest,
           staged_parameters_digest = EXCLUDED.staged_parameters_digest,
           verification_plan_digest = EXCLUDED.verification_plan_digest,
           updated_at = now()`,
        [
          permit.attemptId,
          permit.caseId,
          permit.mastraRunId,
          permit.suspendedStep,
          permit.decisionDigest,
          permit.stagedParametersDigest,
          permit.verificationPlanDigest,
        ],
      );
      await client.query(
        `INSERT INTO incident_approval_permits
        (id, case_id, case_version, attempt_id, mastra_run_id, suspended_step, manifest_digest,
         decision_digest, staged_parameters_digest, verification_plan_digest,
         build_version, prompt_version, schema_version, policy_version, catalog_version,
         collector_version, redaction_version, eligible_roles, expires_at, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [
          permit.id,
          permit.caseId,
          permit.caseVersion,
          permit.attemptId,
          permit.mastraRunId,
          permit.suspendedStep,
          permit.manifestDigest,
          permit.decisionDigest,
          permit.stagedParametersDigest,
          permit.verificationPlanDigest,
          permit.buildVersion,
          permit.promptVersion,
          permit.schemaVersion,
          permit.policyVersion,
          permit.catalogVersion,
          permit.collectorVersion,
          permit.redactionVersion,
          JSON.stringify(permit.eligibleRoles),
          permit.expiresAt,
          permit.status,
          permit.createdAt,
        ],
      );
      await client.query('COMMIT');
      return permit;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async get(permitId: string): Promise<ApprovalPermit | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM incident_approval_permits WHERE id = $1',
      [permitId],
    );
    return rowToPermit(result.rows[0]);
  }

  async getConsumedByAttempt(attemptId: string): Promise<ApprovalPermit | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM incident_approval_permits
       WHERE attempt_id = $1 AND status = 'consumed'
       ORDER BY consumed_at DESC LIMIT 1`,
      [attemptId],
    );
    return rowToPermit(result.rows[0]);
  }

  async getCurrentBinding(
    permitId: string,
    versions: BindingVersions,
  ): Promise<PermitBinding | undefined> {
    const result = await this.pool.query<{
      case_id: string;
      case_version: number;
      attempt_id: string;
      mastra_run_id: string;
      suspended_step: string;
      manifest_digest: string;
      decision_digest: string;
      staged_parameters_digest: string;
      verification_plan_digest: string;
    }>(
      `SELECT a.case_id, c.version AS case_version, a.id AS attempt_id, a.mastra_run_id,
              w.suspended_step, m.digest AS manifest_digest, w.decision_digest,
              w.staged_parameters_digest, w.verification_plan_digest
       FROM incident_approval_permits p
       JOIN incident_attempts a ON a.id = p.attempt_id
       JOIN incident_cases c ON c.id = a.case_id
       JOIN incident_workflow_artifacts w ON w.attempt_id = a.id
       JOIN incident_evidence_manifests m ON m.attempt_id = a.id
       WHERE p.id = $1`,
      [permitId],
    );
    const row = result.rows[0];
    if (!row?.mastra_run_id) return undefined;
    return {
      caseId: row.case_id,
      caseVersion: row.case_version,
      attemptId: row.attempt_id,
      mastraRunId: row.mastra_run_id,
      suspendedStep: row.suspended_step,
      manifestDigest: row.manifest_digest,
      decisionDigest: row.decision_digest,
      stagedParametersDigest: row.staged_parameters_digest,
      verificationPlanDigest: row.verification_plan_digest,
      ...versions,
    };
  }

  async assertResumeAuthorized(input: {
    permitId: string;
    actorId: string;
    actorRole: string;
    decision: 'approved' | 'rejected';
    reason: string;
    versions: BindingVersions;
  }): Promise<ApprovalPermit> {
    const permit = await this.get(input.permitId);
    if (
      !permit ||
      permit.status !== 'consumed' ||
      permit.actorId !== input.actorId ||
      permit.actorRole !== input.actorRole ||
      permit.decision !== input.decision ||
      permit.reason !== input.reason
    ) {
      throw new Error('RESUME_NOT_AUTHORIZED');
    }
    const current = await this.getCurrentBinding(permit.id, input.versions);
    if (!current) throw new Error('PERMIT_STALE');
    assertPermitBinding(
      { ...permit, caseVersion: permit.consumedCaseVersion ?? permit.caseVersion },
      current,
    );
    return permit;
  }

  async recordSimulationOutcome(permit: ApprovalPermit): Promise<boolean> {
    if (!permit.decision) throw new Error('PERMIT_NOT_CONSUMED');
    if (permit.decision !== 'approved') throw new Error('SIMULATION_NOT_APPROVED');
    const result = await this.pool.query(
      `INSERT INTO incident_simulation_outcomes (permit_id, attempt_id, decision, executed)
       VALUES ($1, $2, $3, false) ON CONFLICT (permit_id) DO NOTHING`,
      [permit.id, permit.attemptId, permit.decision],
    );
    return result.rowCount === 1;
  }

  async consume(input: ApprovalDecisionInput): Promise<ApprovalPermit> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const selected = await client.query<Record<string, unknown>>(
        'SELECT * FROM incident_approval_permits WHERE id = $1 FOR UPDATE',
        [input.permitId],
      );
      const permit = rowToPermit(selected.rows[0]);
      if (!permit) throw new Error('PERMIT_NOT_FOUND');
      if (permit.status !== 'pending') throw new Error('PERMIT_CONFLICT');
      const now = input.now ?? new Date();
      if (permit.expiresAt <= now) {
        await client.query(
          `UPDATE incident_approval_permits SET status = 'expired' WHERE id = $1`,
          [permit.id],
        );
        await client.query('COMMIT');
        transactionOpen = false;
        throw new Error('PERMIT_EXPIRED');
      }
      const actorRole = input.actorRoles.find((role) => permit.eligibleRoles.includes(role));
      if (!actorRole) throw new Error('PERMIT_FORBIDDEN');
      if (!input.reason.trim()) throw new Error('APPROVAL_REASON_REQUIRED');
      try {
        assertPermitBinding(permit, input.expectedBinding);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'PERMIT_STALE') throw error;
        await client.query(
          `UPDATE incident_approval_permits SET status = 'superseded' WHERE id = $1`,
          [permit.id],
        );
        await client.query('COMMIT');
        transactionOpen = false;
        throw error;
      }

      const state = await client.query<{ case_id: string; state: string; version: number }>(
        `SELECT a.case_id, a.state, c.version
         FROM incident_attempts a
         JOIN incident_cases c ON c.id = a.case_id
         WHERE a.id = $1 FOR UPDATE OF a, c`,
        [permit.attemptId],
      );
      const current = state.rows[0];
      if (!current) throw new Error('ATTEMPT_NOT_FOUND');
      if (current.version !== permit.caseVersion) throw new Error('PERMIT_STALE');
      const nextVersion = current.version + 1;
      await client.query(
        `UPDATE incident_approval_permits SET status = 'consumed', consumed_at = $2,
           consumed_case_version = $3, actor_id = $4, actor_role = $5, decision = $6, reason = $7
         WHERE id = $1`,
        [
          permit.id,
          now,
          nextVersion,
          input.actorId,
          actorRole,
          input.decision,
          input.reason.trim(),
        ],
      );
      await client.query(
        `INSERT INTO incident_approval_audit
          (id, permit_id, actor_id, actor_role, decision, reason, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          permit.id,
          input.actorId,
          actorRole,
          input.decision,
          input.reason.trim(),
          now,
        ],
      );
      await client.query(
        `UPDATE incident_cases SET state = 'resume_queued', version = $2, updated_at = now()
         WHERE id = $1`,
        [current.case_id, nextVersion],
      );
      await client.query(
        `UPDATE incident_attempts SET state = 'resume_queued', case_version = $2,
           updated_at = now() WHERE id = $1`,
        [permit.attemptId, nextVersion],
      );
      await client.query(
        `INSERT INTO incident_case_transitions
          (id, case_id, attempt_id, from_state, to_state, case_version, reason_code, actor_id)
         VALUES ($1,$2,$3,$4,'resume_queued',$5,'APPROVAL_DECIDED',$6)`,
        [
          randomUUID(),
          current.case_id,
          permit.attemptId,
          current.state,
          nextVersion,
          input.actorId,
        ],
      );
      await client.query(
        `INSERT INTO incident_outbox (id, kind, attempt_id, status)
         VALUES ($1, 'resume_workflow', $2, 'pending')
         ON CONFLICT (kind, attempt_id) DO NOTHING`,
        [randomUUID(), permit.attemptId],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return {
        ...permit,
        status: 'consumed',
        consumedAt: now,
        consumedCaseVersion: nextVersion,
        actorId: input.actorId,
        actorRole,
        decision: input.decision,
        reason: input.reason.trim(),
      };
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function rowToPermit(row: Record<string, unknown> | undefined): ApprovalPermit | undefined {
  if (!row) return undefined;
  const permit: ApprovalPermit = {
    id: String(row.id),
    caseId: String(row.case_id),
    caseVersion: Number(row.case_version),
    attemptId: String(row.attempt_id),
    mastraRunId: String(row.mastra_run_id),
    suspendedStep: String(row.suspended_step),
    manifestDigest: String(row.manifest_digest),
    decisionDigest: String(row.decision_digest),
    stagedParametersDigest: String(row.staged_parameters_digest),
    verificationPlanDigest: String(row.verification_plan_digest),
    buildVersion: String(row.build_version),
    promptVersion: String(row.prompt_version),
    schemaVersion: String(row.schema_version),
    policyVersion: String(row.policy_version),
    catalogVersion: String(row.catalog_version),
    collectorVersion: String(row.collector_version),
    redactionVersion: String(row.redaction_version),
    eligibleRoles: row.eligible_roles as string[],
    expiresAt: new Date(String(row.expires_at)),
    status: row.status as ApprovalPermit['status'],
    createdAt: new Date(String(row.created_at)),
  };
  if (row.consumed_at) permit.consumedAt = new Date(String(row.consumed_at));
  if (row.consumed_case_version) permit.consumedCaseVersion = Number(row.consumed_case_version);
  if (row.actor_id) permit.actorId = String(row.actor_id);
  if (row.actor_role) permit.actorRole = String(row.actor_role);
  if (row.decision) permit.decision = row.decision as NonNullable<ApprovalPermit['decision']>;
  if (row.reason) permit.reason = String(row.reason);
  return permit;
}
