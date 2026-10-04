import { describe, expect, it, vi } from 'vitest';

import { InMemoryCaseRepository } from '../src/persistence/repositories/case-repository.js';
import { dispatchOnce } from '../src/worker/dispatcher.js';
import { reconcileAttempt } from '../src/worker/reconcile.js';

describe('workflow dispatcher', () => {
  it('lets one racing worker bind and dispatch one authoritative run', async () => {
    const repository = new InMemoryCaseRepository();
    const accepted = await repository.acceptDelivery({
      source: 'fixture',
      deliveryId: 'delivery',
      sourceIncidentId: 'incident',
      redactedPayload: { summary: 'errors' },
    });
    const startAsync = vi.fn(async () => ({ runId: 'ignored' }));
    const workflow = { createRun: vi.fn(async () => ({ startAsync })) };
    const run = (workerId: string) =>
      dispatchOnce({
        repository,
        workflow,
        workerId,
        leaseMs: 1000,
        now: new Date('2026-01-01T00:00:00Z'),
        loadInput: async () => ({ attemptId: accepted.attemptId }),
      });

    const outcomes = await Promise.all([run('worker-a'), run('worker-b')]);

    expect(outcomes.sort()).toEqual(['dispatched', 'idle']);
    expect(startAsync).toHaveBeenCalledTimes(1);
    expect(repository.getAttempt(accepted.attemptId)?.mastraRunId).toMatch(/^incident-/u);
  });

  it('reconciles a bound run instead of creating another judgment', async () => {
    const result = await reconcileAttempt({
      attempt: {
        id: 'attempt',
        caseId: 'case',
        deliveryId: 'delivery',
        state: 'collecting_evidence',
        mastraRunId: 'run-1',
      },
      getWorkflowRun: async (runId) => (runId === 'run-1' ? { status: 'running' } : null),
    });

    expect(result).toBe('known_run');
  });
});
