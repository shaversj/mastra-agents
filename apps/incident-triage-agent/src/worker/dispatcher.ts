import { randomUUID } from 'node:crypto';

import type { FailureClassification } from '../domain/case.js';
import type { OutboxLease } from '../persistence/repositories/outbox-repository.js';

export interface DispatchRepository {
  claimNext(owner: string, now: Date, leaseMs: number): Promise<OutboxLease | null>;
  bindMastraRun(attemptId: string, runId: string): Promise<void>;
  markOutboxDispatched(outboxId: string, owner: string, generation: number): Promise<void>;
  recordDispatchFailure(input: {
    outboxId: string;
    leaseOwner: string;
    leaseGeneration: number;
    classification: FailureClassification;
    reasonCode: string;
    now: Date;
  }): Promise<void>;
}

export interface DispatchWorkflow<TInput> {
  createRun(options: { runId: string }): Promise<{
    startAsync(args: { inputData: TInput }): Promise<{ runId: string }>;
  }>;
}

export async function dispatchOnce<TInput>(options: {
  repository: DispatchRepository;
  workflow: DispatchWorkflow<TInput>;
  loadInput(attemptId: string): Promise<TInput>;
  workerId: string;
  leaseMs: number;
  now?: Date;
}): Promise<'idle' | 'dispatched' | 'failed'> {
  const now = options.now ?? new Date();
  const lease = await options.repository.claimNext(options.workerId, now, options.leaseMs);
  if (!lease) return 'idle';
  if (lease.kind !== 'start_workflow') return 'idle';

  const runId = `incident-${lease.attemptId}-${randomUUID()}`;
  try {
    const input = await options.loadInput(lease.attemptId);
    const run = await options.workflow.createRun({ runId });
    await options.repository.bindMastraRun(lease.attemptId, runId);
    await run.startAsync({ inputData: input });
    await options.repository.markOutboxDispatched(lease.id, options.workerId, lease.generation);
    return 'dispatched';
  } catch {
    await options.repository.recordDispatchFailure({
      outboxId: lease.id,
      leaseOwner: options.workerId,
      leaseGeneration: lease.generation,
      classification: 'retryable',
      reasonCode: 'WORKFLOW_DISPATCH_FAILED',
      now,
    });
    return 'failed';
  }
}
