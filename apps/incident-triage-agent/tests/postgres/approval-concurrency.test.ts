import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPermit } from '../../src/approvals/permit.js';
import { assertPermitBinding } from '../../src/approvals/revalidate.js';
import type { PermitBinding } from '../../src/domain/approval.js';
import { PgEvidenceLedger } from '../../src/evidence/ledger.js';
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
    const ledger = new PgEvidenceLedger(pool);
    await ledger.record(accepted.attemptId, {
      source: 'fixture',
      sourceTier: 'primary',
      sourceLocator: 'fixture/approval-race',
      observedAt: '2026-10-03T18:00:00.000Z',
      collectorVersion: 'collector/v1',
      redactionVersion: 'redaction/v1',
      canonicalizationVersion: 'canonical-json/v1',
      freshness: 'fresh',
      collectionStatus: 'complete',
      normalizedPayload: { summary: 'capacity' },
    });
    const manifest = await ledger.seal(accepted.attemptId);
    const binding: PermitBinding = {
      caseId: accepted.caseId,
      caseVersion: 1,
      attemptId: accepted.attemptId,
      mastraRunId: 'run-approval',
      suspendedStep: 'governed-approval',
      manifestDigest: manifest.digest,
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
    const lease = await cases.claimNext('worker', new Date(), 60_000);
    if (!lease) throw new Error('Expected start lease');
    await cases.projectWorkflowOutcome({
      outboxId: lease.id,
      leaseOwner: lease.owner,
      leaseGeneration: lease.generation,
      expectedCaseVersion: lease.caseVersion,
      to: 'approval_pending',
      reasonCode: 'APPROVAL_REQUIRED',
    });
    const versions = {
      buildVersion: binding.buildVersion,
      promptVersion: binding.promptVersion,
      schemaVersion: binding.schemaVersion,
      policyVersion: binding.policyVersion,
      catalogVersion: binding.catalogVersion,
      collectorVersion: binding.collectorVersion,
      redactionVersion: binding.redactionVersion,
    };
    const currentBinding = await approvals.getCurrentBinding(permit.id, versions);
    if (!currentBinding) throw new Error('Expected current binding');
    const pendingPermit = await approvals.get(permit.id);
    if (!pendingPermit) throw new Error('Expected pending permit');
    expect(pendingPermit.caseVersion).toBe(2);
    expect(() => assertPermitBinding(pendingPermit, currentBinding)).not.toThrow();
    const decide = () =>
      approvals.consume({
        permitId: permit.id,
        actorId: 'approver',
        actorRoles: ['incident-approver'],
        decision: 'approved',
        reason: 'Reviewed',
        expectedBinding: currentBinding,
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
    const caseState = await pool.query<{ state: string }>(
      'SELECT state FROM incident_cases WHERE id = $1',
      [accepted.caseId],
    );
    expect(caseState.rows[0]?.state).toBe('resume_queued');
    const consumed = await approvals.getConsumedByAttempt(accepted.attemptId);
    if (!consumed) throw new Error('Expected consumed permit');
    expect(consumed?.decision).toBe('approved');
    await expect(
      approvals.assertResumeAuthorized({
        permitId: consumed.id,
        actorId: 'approver',
        actorRole: 'incident-approver',
        decision: 'approved',
        reason: 'Reviewed',
        versions,
      }),
    ).resolves.toMatchObject({ id: consumed.id });
    await pool.query(
      `UPDATE incident_workflow_artifacts SET decision_digest = 'changed' WHERE attempt_id = $1`,
      [accepted.attemptId],
    );
    await expect(
      approvals.assertResumeAuthorized({
        permitId: consumed.id,
        actorId: 'approver',
        actorRole: 'incident-approver',
        decision: 'approved',
        reason: 'Reviewed',
        versions,
      }),
    ).rejects.toThrow('PERMIT_STALE');
    expect(await approvals.recordSimulationOutcome(consumed)).toBe(true);
    expect(await approvals.recordSimulationOutcome(consumed)).toBe(false);
    const outcome = await pool.query(
      'SELECT decision, executed FROM incident_simulation_outcomes WHERE permit_id = $1',
      [permit.id],
    );
    expect(outcome.rows).toEqual([{ decision: 'approved', executed: false }]);
  });

  it('persists an explicit expired status without enqueuing resume work', async () => {
    const cases = new PgCaseRepository(pool);
    const accepted = await cases.acceptDelivery({
      source: 'fixture',
      deliveryId: randomUUID(),
      sourceIncidentId: 'expired-approval',
      redactedPayload: { summary: 'capacity' },
    });
    await cases.bindMastraRun(accepted.attemptId, 'run-expired');
    const binding: PermitBinding = {
      caseId: accepted.caseId,
      caseVersion: 1,
      attemptId: accepted.attemptId,
      mastraRunId: 'run-expired',
      suspendedStep: 'governed-approval',
      manifestDigest: 'manifest',
      decisionDigest: 'expired-decision',
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
      expiresAt: new Date('2026-10-03T19:00:00.000Z'),
      now: new Date('2026-10-03T18:00:00.000Z'),
    });
    const approvals = new PgApprovalRepository(pool);
    await approvals.insert(permit);

    await expect(
      approvals.consume({
        permitId: permit.id,
        actorId: 'approver',
        actorRoles: ['incident-approver'],
        decision: 'approved',
        reason: 'Too late',
        expectedBinding: binding,
        now: new Date('2026-10-03T20:00:00.000Z'),
      }),
    ).rejects.toThrow('PERMIT_EXPIRED');

    expect(await approvals.get(permit.id)).toMatchObject({ status: 'expired' });
    const resumeCount = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM incident_outbox
       WHERE attempt_id = $1 AND kind = 'resume_workflow'`,
      [accepted.attemptId],
    );
    expect(resumeCount.rows[0]?.count).toBe(0);
  });
});
