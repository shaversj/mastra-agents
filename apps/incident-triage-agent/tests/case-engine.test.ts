import { describe, expect, it } from 'vitest';

import { InMemoryCaseRepository } from '../src/persistence/repositories/case-repository.js';

const delivery = {
  source: 'fixture',
  deliveryId: 'delivery-1',
  sourceIncidentId: 'incident-42',
  redactedPayload: { summary: 'API errors' },
};

describe('durable case behavior', () => {
  it('deduplicates racing deliveries into one attempt and outbox item', async () => {
    const repository = new InMemoryCaseRepository();
    const [first, second] = await Promise.all([
      repository.acceptDelivery(delivery),
      repository.acceptDelivery(delivery),
    ]);

    expect(second).toMatchObject({ caseId: first.caseId, attemptId: first.attemptId });
    expect(repository.snapshot()).toMatchObject({
      cases: [{ id: first.caseId }],
      attempts: [{ id: first.attemptId }],
      outbox: [{ attemptId: first.attemptId, status: 'pending' }],
    });
  });

  it('creates a later attempt under the correlated case', async () => {
    const repository = new InMemoryCaseRepository();
    const first = await repository.acceptDelivery(delivery);
    const second = await repository.acceptDelivery({ ...delivery, deliveryId: 'delivery-2' });

    expect(second.caseId).toBe(first.caseId);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(repository.snapshot().attempts).toHaveLength(2);
  });

  it('fences a worker holding an expired lease generation', async () => {
    const repository = new InMemoryCaseRepository();
    const accepted = await repository.acceptDelivery(delivery);
    const firstLease = await repository.claimNext(
      'worker-a',
      new Date('2026-01-01T00:00:00Z'),
      1000,
    );
    const secondLease = await repository.claimNext(
      'worker-b',
      new Date('2026-01-01T00:00:02Z'),
      1000,
    );

    expect(firstLease?.generation).toBe(1);
    expect(secondLease?.generation).toBe(2);
    await expect(
      repository.transitionAttempt({
        attemptId: accepted.attemptId,
        expectedCaseVersion: 1,
        leaseOwner: 'worker-a',
        leaseGeneration: 1,
        to: 'collecting_evidence',
        reasonCode: 'DISPATCHED',
      }),
    ).rejects.toThrow('STALE_LEASE');
  });

  it('keeps accepted work reclaimable after a dispatch crash', async () => {
    const repository = new InMemoryCaseRepository();
    await repository.acceptDelivery(delivery);
    await repository.claimNext('worker-a', new Date('2026-01-01T00:00:00Z'), 1000);

    const reclaimed = await repository.claimNext(
      'worker-b',
      new Date('2026-01-01T00:00:02Z'),
      1000,
    );
    expect(reclaimed).toMatchObject({ owner: 'worker-b', generation: 2 });
  });

  it('retries retryable work and terminates it at the attempt limit', async () => {
    const repository = new InMemoryCaseRepository({ maxDispatchAttempts: 2 });
    const accepted = await repository.acceptDelivery(delivery);
    const first = await repository.claimNext('worker', new Date('2026-01-01T00:00:00Z'), 1000);
    if (!first) throw new Error('Expected first lease');

    await repository.recordDispatchFailure({
      outboxId: first.id,
      leaseOwner: 'worker',
      leaseGeneration: first.generation,
      expectedCaseVersion: first.caseVersion,
      classification: 'retryable',
      reasonCode: 'PROVIDER_TIMEOUT',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(repository.getAttempt(accepted.attemptId)?.state).toBe('retry_wait');

    const second = await repository.claimNext('worker', new Date('2026-01-01T00:00:03Z'), 1000);
    if (!second) throw new Error('Expected second lease');
    await repository.recordDispatchFailure({
      outboxId: second.id,
      leaseOwner: 'worker',
      leaseGeneration: second.generation,
      expectedCaseVersion: second.caseVersion,
      classification: 'retryable',
      reasonCode: 'PROVIDER_TIMEOUT',
      now: new Date('2026-01-01T00:00:03Z'),
    });

    expect(repository.getAttempt(accepted.attemptId)?.state).toBe('recoverable_failure');
    expect(repository.snapshot().outbox[0]?.status).toBe('failed');
  });

  it('rejects unbounded failure reasons', async () => {
    const repository = new InMemoryCaseRepository();
    await repository.acceptDelivery(delivery);
    const lease = await repository.claimNext('worker', new Date(), 1000);
    if (!lease) throw new Error('Expected lease');

    await expect(
      repository.recordDispatchFailure({
        outboxId: lease.id,
        leaseOwner: 'worker',
        leaseGeneration: lease.generation,
        expectedCaseVersion: lease.caseVersion,
        classification: 'invalid_input',
        reasonCode: 'raw provider body: secret',
        now: new Date(),
      }),
    ).rejects.toThrow('INVALID_REASON_CODE');
  });
});
