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
    const start = vi.fn(async () => ({ status: 'success', result: {} }));
    const workflow = {
      getWorkflowRunById: vi.fn(async () => null),
      createRun: vi.fn(async () => ({ start })),
    };
    const run = (workerId: string) =>
      dispatchOnce({
        repository,
        workflow,
        workerId,
        leaseMs: 1000,
        now: new Date('2026-01-01T00:00:00Z'),
        loadInput: async () => ({ attemptId: accepted.attemptId }),
        classifyStartResult: () => ({ state: 'completed', reasonCode: 'WORKFLOW_COMPLETED' }),
      });

    const outcomes = await Promise.all([run('worker-a'), run('worker-b')]);

    expect(outcomes.sort()).toEqual(['dispatched', 'idle']);
    expect(start).toHaveBeenCalledTimes(1);
    expect(repository.getAttempt(accepted.attemptId)?.mastraRunId).toMatch(/^incident-/u);
  });

  it('reconciles a bound run instead of creating another judgment', async () => {
    const result = await reconcileAttempt({
      attempt: {
        id: 'attempt',
        caseId: 'case',
        caseVersion: 1,
        deliveryId: 'delivery',
        state: 'collecting_evidence',
        mastraRunId: 'run-1',
      },
      getWorkflowRun: async (runId) => (runId === 'run-1' ? { status: 'running' } : null),
    });

    expect(result).toBe('known_run');
  });

  it('projects a stored run after an uncertain dispatch without starting it again', async () => {
    const repository = new InMemoryCaseRepository();
    const accepted = await repository.acceptDelivery({
      source: 'fixture',
      deliveryId: 'reconcile-delivery',
      sourceIncidentId: 'reconcile-incident',
      redactedPayload: { summary: 'errors' },
    });
    const start = vi.fn();
    const workflow = {
      getWorkflowRunById: vi.fn(async () => ({ status: 'success', result: {} })),
      createRun: vi.fn(async () => ({ start })),
    };

    const outcome = await dispatchOnce({
      repository,
      workflow,
      workerId: 'worker-a',
      leaseMs: 1000,
      now: new Date('2026-01-01T00:00:00Z'),
      loadInput: async () => ({ attemptId: accepted.attemptId }),
      classifyStartResult: () => ({ state: 'completed', reasonCode: 'WORKFLOW_COMPLETED' }),
    });

    expect(outcome).toBe('dispatched');
    expect(start).not.toHaveBeenCalled();
    expect(repository.getAttempt(accepted.attemptId)?.state).toBe('completed');
  });

  it('does not let an older attempt overwrite a newer correlated delivery', async () => {
    const repository = new InMemoryCaseRepository();
    await repository.acceptDelivery({
      source: 'fixture',
      deliveryId: 'delivery-old',
      sourceIncidentId: 'same-incident',
      redactedPayload: { summary: 'old' },
    });
    const workflow = {
      getWorkflowRunById: vi.fn(async () => {
        await repository.acceptDelivery({
          source: 'fixture',
          deliveryId: 'delivery-new',
          sourceIncidentId: 'same-incident',
          redactedPayload: { summary: 'new' },
        });
        return { status: 'success', result: {} };
      }),
      createRun: vi.fn(),
    };

    const outcome = await dispatchOnce({
      repository,
      workflow,
      workerId: 'worker-a',
      leaseMs: 1000,
      loadInput: async () => ({ unused: true }),
      classifyStartResult: () => ({ state: 'completed', reasonCode: 'WORKFLOW_COMPLETED' }),
    });

    expect(outcome).toBe('failed');
    expect(repository.snapshot().cases[0]).toMatchObject({ state: 'queued', version: 2 });
    expect(repository.snapshot().outbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'failed', reasonCode: 'STALE_CASE_VERSION' }),
        expect.objectContaining({ status: 'pending' }),
      ]),
    );
  });
});
