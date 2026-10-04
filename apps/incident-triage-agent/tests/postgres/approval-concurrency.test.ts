import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPermit } from '../../src/approvals/permit.js';
import type { PermitBinding } from '../../src/domain/approval.js';
import { applyMigrations } from '../../src/persistence/migrate.js';
import { PgApprovalRepository } from '../../src/persistence/repositories/approval-repository.js';
import { PgCaseRepository } from '../../src/persistence/repositories/case-repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('Postgres approval concurrency', () => {
  const schema = `approval_test_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `--search_path=${schema}` });
    await applyMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('commits one decision, audit row, and resume request', async () => {
    const cases = new PgCaseRepository(pool);
    const accepted = await cases.acceptDelivery({
      source: 'fixture',
      deliveryId: randomUUID(),
      sourceIncidentId: 'approval-race',
      redactedPayload: { summary: 'capacity' },
    });
    await cases.bindMastraRun(accepted.attemptId, 'run-approval');
    const binding: PermitBinding = {
      caseId: accepted.caseId,
      attemptId: accepted.attemptId,
      mastraRunId: 'run-approval',
      suspendedStep: 'governed-approval',
      manifestDigest: 'manifest',
      decisionDigest: 'decision',
      stagedParametersDigest: 'parameters',
      verificationPlanDigest: 'verification',
      buildVersion: 'build/v1',
      promptVersion: 'prompt/v1',
      schemaVersion: 'schema/v1',
      policyVersion: 'policy/v1',
      catalogVersion: 'catalog/v1',
      collectorVersion: 'collector/v1',
      redactionVersion: 'redaction/v1',
    };
    const permit = createPermit({
      binding,
      eligibleRoles: ['incident-approver'],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const approvals = new PgApprovalRepository(pool);
    await approvals.insert(permit);
    const decide = () =>
      approvals.consume({
        permitId: permit.id,
        actorId: 'approver',
        actorRoles: ['incident-approver'],
        decision: 'approved',
        reason: 'Reviewed',
        expectedBinding: binding,
      });

    const outcomes = await Promise.allSettled([decide(), decide()]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const counts = await pool.query<{ audits: number; resumes: number }>(
      `SELECT
        (SELECT count(*)::integer FROM incident_approval_audit WHERE permit_id = $1) AS audits,
        (SELECT count(*)::integer FROM incident_outbox WHERE attempt_id = $2 AND kind = 'resume_workflow') AS resumes`,
      [permit.id, accepted.attemptId],
    );
    expect(counts.rows[0]).toEqual({ audits: 1, resumes: 1 });
    const consumed = await approvals.getConsumedByAttempt(accepted.attemptId);
    if (!consumed) throw new Error('Expected consumed permit');
    expect(consumed?.decision).toBe('approved');
    expect(await approvals.recordSimulationOutcome(consumed)).toBe(true);
    expect(await approvals.recordSimulationOutcome(consumed)).toBe(false);
    const outcome = await pool.query(
      'SELECT decision, executed FROM incident_simulation_outcomes WHERE permit_id = $1',
      [permit.id],
    );
    expect(outcome.rows).toEqual([{ decision: 'approved', executed: false }]);
  });
});
