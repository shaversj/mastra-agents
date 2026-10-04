import { loadAppConfig } from '../config/app.js';
import { mastra } from '../mastra/index.js';
import { workflowInputSchema } from '../mastra/workflows/incident-triage.js';
import { createDatabasePool } from '../persistence/db.js';
import { PgApprovalRepository } from '../persistence/repositories/approval-repository.js';
import { PgCaseRepository } from '../persistence/repositories/case-repository.js';
import { dispatchOnce } from './dispatcher.js';

export async function runWorker(): Promise<void> {
  const config = loadAppConfig();
  if (config.processRole !== 'worker') throw new Error('PROCESS_ROLE must be worker');
  const pool = createDatabasePool(config);
  const repository = new PgCaseRepository(pool);
  const approvals = new PgApprovalRepository(pool);
  const workflow = mastra.getWorkflow('incident-triage-workflow');

  try {
    while (true) {
      const outcome = await dispatchOnce({
        repository,
        workflow,
        workerId: `worker-${process.pid}`,
        leaseMs: config.workerLeaseSeconds * 1000,
        resume: async (lease) => {
          const permit = await approvals.getConsumedByAttempt(lease.attemptId);
          if (
            !permit ||
            !permit.actorId ||
            !permit.actorRole ||
            !permit.decision ||
            !permit.reason
          ) {
            throw new Error('CONSUMED_PERMIT_NOT_FOUND');
          }
          const run = await workflow.createRun({ runId: permit.mastraRunId });
          const result = await run.resume({
            step: permit.suspendedStep,
            resumeData: {
              permitId: permit.id,
              decision: permit.decision,
              reason: permit.reason,
              actorId: permit.actorId,
              actorRole: permit.actorRole,
            },
          });
          if (result.status !== 'success') throw new Error('WORKFLOW_RESUME_INCOMPLETE');
          await approvals.recordSimulationOutcome(permit);
        },
        loadInput: async (attemptId) => {
          const result = await pool.query<{
            payload: Record<string, unknown>;
            manifest_id: string;
            digest: string;
            items: unknown;
            sealed_at: Date;
          }>(
            `SELECT d.redacted_payload AS payload, m.id AS manifest_id, m.digest, m.items, m.sealed_at
             FROM incident_attempts a
             JOIN incident_deliveries d
               ON d.source = a.delivery_source AND d.delivery_id = a.delivery_id
             JOIN incident_evidence_manifests m ON m.attempt_id = a.id
             WHERE a.id = $1`,
            [attemptId],
          );
          const row = result.rows[0];
          if (!row) throw new Error('ATTEMPT_INPUT_NOT_READY');
          return workflowInputSchema.parse({
            attemptId,
            incident: row.payload,
            manifest: {
              id: row.manifest_id,
              attemptId,
              digest: row.digest,
              items: row.items,
              sealedAt: row.sealed_at.toISOString(),
            },
          });
        },
      });
      if (outcome === 'idle') await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await runWorker();
}
