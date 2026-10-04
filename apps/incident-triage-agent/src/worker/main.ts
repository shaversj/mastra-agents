import { loadAppConfig } from '../config/app.js';
import { currentBindingVersions } from '../approvals/binding.js';
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
          await approvals.assertResumeAuthorized({
            permitId: permit.id,
            actorId: permit.actorId,
            actorRole: permit.actorRole,
            decision: permit.decision,
            reason: permit.reason,
            versions: currentBindingVersions(),
          });
          const existing = await workflow.getWorkflowRunById(permit.mastraRunId);
          if (existing?.status === 'failed') {
            return {
              state: 'recoverable_failure' as const,
              reasonCode: 'WORKFLOW_RESUME_FAILED',
              outboxStatus: 'failed' as const,
            };
          }
          if (existing && existing.status !== 'success' && existing.status !== 'suspended') {
            throw new Error('WORKFLOW_RESUME_NOT_READY');
          }
          const result =
            existing?.status === 'success'
              ? existing
              : await (
                  await workflow.createRun({ runId: permit.mastraRunId })
                ).resume({
                  step: permit.suspendedStep,
                  resumeData: {
                    permitId: permit.id,
                    decision: permit.decision,
                    reason: permit.reason,
                    actorId: permit.actorId,
                    actorRole: permit.actorRole,
                  },
                });
          if (result.status !== 'success') {
            return {
              state: 'recoverable_failure' as const,
              reasonCode: 'WORKFLOW_RESUME_FAILED',
              outboxStatus: 'failed' as const,
            };
          }
          if (permit.decision === 'approved') {
            await approvals.recordSimulationOutcome(permit);
            return {
              state: 'simulation_recorded' as const,
              reasonCode: 'SIMULATION_RECORDED',
            };
          }
          return { state: 'completed' as const, reasonCode: 'APPROVAL_REJECTED' };
        },
        classifyStartResult: (result) => {
          if (result.status === 'suspended') {
            return { state: 'approval_pending', reasonCode: 'APPROVAL_REQUIRED' };
          }
          if (result.status === 'failed') {
            return {
              state: 'recoverable_failure',
              reasonCode: 'WORKFLOW_FAILED',
              outboxStatus: 'failed',
            };
          }
          if (result.status !== 'success') throw new Error('WORKFLOW_NOT_TERMINAL');
          const disposition = (result.result as { policy?: { disposition?: string } } | undefined)
            ?.policy?.disposition;
          return disposition === 'human_input_needed'
            ? { state: 'human_input_needed', reasonCode: 'HUMAN_INPUT_NEEDED' }
            : { state: 'completed', reasonCode: 'WORKFLOW_COMPLETED' };
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
