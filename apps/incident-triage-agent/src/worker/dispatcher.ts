import type { CaseState, FailureClassification } from '../domain/case.js';
import type { WorkflowProjectionInput } from '../persistence/repositories/case-repository.js';
import type { OutboxLease } from '../persistence/repositories/outbox-repository.js';

export interface DispatchRepository {
  claimNext(owner: string, now: Date, leaseMs: number): Promise<OutboxLease | null>;
  bindMastraRun(attemptId: string, runId: string): Promise<void>;
  markOutboxDispatched(outboxId: string, owner: string, generation: number): Promise<void>;
  projectWorkflowOutcome(input: WorkflowProjectionInput): Promise<void>;
  recordDispatchFailure(input: {
    outboxId: string;
    leaseOwner: string;
    leaseGeneration: number;
    expectedCaseVersion: number;
    classification: FailureClassification;
    reasonCode: string;
    now: Date;
  }): Promise<void>;
}

export interface DispatchWorkflow<TInput> {
  getWorkflowRunById(runId: string): Promise<WorkflowDispatchResult | null>;
  createRun(options: { runId: string }): Promise<{
    start(args: { inputData: TInput }): Promise<WorkflowDispatchResult>;
  }>;
}

export interface WorkflowDispatchResult {
  status: string;
  result?: unknown;
}

export interface WorkflowProjection {
  state: CaseState;
  reasonCode: string;
  outboxStatus?: 'completed' | 'failed';
}

export async function dispatchOnce<TInput>(options: {
  repository: DispatchRepository;
  workflow: DispatchWorkflow<TInput>;
  loadInput(attemptId: string): Promise<TInput>;
  workerId: string;
  leaseMs: number;
  now?: Date;
  resume?: (lease: OutboxLease) => Promise<WorkflowProjection>;
  classifyStartResult(result: WorkflowDispatchResult): WorkflowProjection;
}): Promise<'idle' | 'dispatched' | 'failed'> {
  const now = options.now ?? new Date();
  const lease = await options.repository.claimNext(options.workerId, now, options.leaseMs);
  if (!lease) return 'idle';
  if (lease.kind === 'resume_workflow') {
    try {
      if (!options.resume) throw new Error('RESUME_HANDLER_MISSING');
      const projection = await options.resume(lease);
      await options.repository.projectWorkflowOutcome({
        outboxId: lease.id,
        leaseOwner: options.workerId,
        leaseGeneration: lease.generation,
        expectedCaseVersion: lease.caseVersion,
        to: projection.state,
        reasonCode: projection.reasonCode,
        ...(projection.outboxStatus ? { outboxStatus: projection.outboxStatus } : {}),
      });
      return projection.outboxStatus === 'failed' ? 'failed' : 'dispatched';
    } catch {
      await options.repository.recordDispatchFailure({
        outboxId: lease.id,
        leaseOwner: options.workerId,
        leaseGeneration: lease.generation,
        expectedCaseVersion: lease.caseVersion,
        classification: 'retryable',
        reasonCode: 'WORKFLOW_RESUME_FAILED',
        now,
      });
      return 'failed';
    }
  }

  const runId = `incident-${lease.attemptId}`;
  try {
    await options.repository.bindMastraRun(lease.attemptId, runId);
    let result = await options.workflow.getWorkflowRunById(runId);
    if (!result) {
      const input = await options.loadInput(lease.attemptId);
      const run = await options.workflow.createRun({ runId });
      result = await run.start({ inputData: input });
    }
    const projection = options.classifyStartResult(result);
    await options.repository.projectWorkflowOutcome({
      outboxId: lease.id,
      leaseOwner: options.workerId,
      leaseGeneration: lease.generation,
      expectedCaseVersion: lease.caseVersion,
      to: projection.state,
      reasonCode: projection.reasonCode,
      ...(projection.outboxStatus ? { outboxStatus: projection.outboxStatus } : {}),
    });
    return projection.outboxStatus === 'failed' ? 'failed' : 'dispatched';
  } catch {
    await options.repository.recordDispatchFailure({
      outboxId: lease.id,
      leaseOwner: options.workerId,
      leaseGeneration: lease.generation,
      expectedCaseVersion: lease.caseVersion,
      classification: 'retryable',
      reasonCode: 'WORKFLOW_DISPATCH_FAILED',
      now,
    });
    return 'failed';
  }
}
