import { loadAppConfig } from '../config/app.js';
import { mastra } from '../mastra/index.js';
import { createDatabasePool } from '../persistence/db.js';
import { PgApprovalRepository } from '../persistence/repositories/approval-repository.js';
import { PgCaseRepository } from '../persistence/repositories/case-repository.js';
import { dispatchOnce } from './dispatcher.js';
import { loadWorkflowInput } from './input.js';

export async function runWorker(): Promise<void> {
  const config = loadAppConfig();
  if (config.processRole !== 'worker') throw new Error('PROCESS_ROLE must be worker');
  const pool = createDatabasePool(config);
  const repository = new PgCaseRepository(pool);
  const approvals = new PgApprovalRepository(pool);
  const workflow = mastra.getWorkflow('incident-triage-workflow');
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (!stopping) {
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
        loadInput: (attemptId) => loadWorkflowInput(pool, attemptId),
      });
      if (outcome === 'idle') await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await mastra.shutdown({ drainTimeout: 5000 });
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await runWorker();
}
