import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import {
  assertReasonCode,
  type AttemptRecord,
  type CaseRecord,
  type CaseState,
  type CaseTransition,
  type FailureClassification,
} from '../../domain/case.js';
import type { AcceptedDelivery, IncidentDeliveryInput } from '../../domain/incident.js';
import type { OutboxLease, OutboxRecord } from './outbox-repository.js';

interface TransitionInput {
  attemptId: string;
  expectedCaseVersion: number;
  leaseOwner: string;
  leaseGeneration: number;
  to: CaseState;
  reasonCode: string;
}

interface DispatchFailureInput {
  outboxId: string;
  leaseOwner: string;
  leaseGeneration: number;
  classification: FailureClassification;
  reasonCode: string;
  now: Date;
}

interface RepositoryOptions {
  maxDispatchAttempts?: number;
}

function correlationKey(input: IncidentDeliveryInput): string {
  return `${input.source}\u0000${input.sourceIncidentId}`;
}

function deliveryKey(input: Pick<IncidentDeliveryInput, 'source' | 'deliveryId'>): string {
  return `${input.source}\u0000${input.deliveryId}`;
}

export class InMemoryCaseRepository {
  private readonly cases = new Map<string, CaseRecord>();
  private readonly caseByCorrelation = new Map<string, string>();
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly deliveryResults = new Map<string, AcceptedDelivery>();
  private readonly transitions: CaseTransition[] = [];
  private readonly outbox = new Map<string, OutboxRecord>();
  private readonly maxDispatchAttempts: number;

  constructor(options: RepositoryOptions = {}) {
    this.maxDispatchAttempts = options.maxDispatchAttempts ?? 5;
  }

  async acceptDelivery(input: IncidentDeliveryInput): Promise<AcceptedDelivery> {
    const key = deliveryKey(input);
    const existing = this.deliveryResults.get(key);
    if (existing) return { ...existing, duplicate: true };

    const correlatedId = this.caseByCorrelation.get(correlationKey(input));
    const caseRecord = correlatedId
      ? this.cases.get(correlatedId)!
      : {
          id: randomUUID(),
          source: input.source,
          sourceIncidentId: input.sourceIncidentId,
          state: 'queued' as const,
          version: 0,
        };
    if (!correlatedId) {
      this.cases.set(caseRecord.id, caseRecord);
      this.caseByCorrelation.set(correlationKey(input), caseRecord.id);
    }

    const attempt: AttemptRecord = {
      id: randomUUID(),
      caseId: caseRecord.id,
      deliveryId: input.deliveryId,
      state: 'queued',
    };
    caseRecord.version += 1;
    caseRecord.state = 'queued';
    this.attempts.set(attempt.id, attempt);
    this.transitions.push({
      id: randomUUID(),
      caseId: caseRecord.id,
      attemptId: attempt.id,
      fromState: correlatedId ? caseRecord.state : null,
      toState: 'queued',
      caseVersion: caseRecord.version,
      reasonCode: 'DELIVERY_ACCEPTED',
      createdAt: new Date(),
    });
    this.outbox.set(attempt.id, {
      id: randomUUID(),
      kind: 'start_workflow',
      attemptId: attempt.id,
      status: 'pending',
      dispatchAttempts: 0,
      nextAttemptAt: new Date(0),
      leaseGeneration: 0,
    });
    const result = { caseId: caseRecord.id, attemptId: attempt.id, duplicate: false };
    this.deliveryResults.set(key, result);
    return result;
  }

  async claimNext(owner: string, now: Date, leaseMs: number): Promise<OutboxLease | null> {
    const candidate = [...this.outbox.values()]
      .filter(
        (row) =>
          (row.status === 'pending' ||
            (row.status === 'leased' && row.leaseExpiresAt && row.leaseExpiresAt <= now)) &&
          row.nextAttemptAt <= now,
      )
      .sort((left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime())[0];
    if (!candidate) return null;

    candidate.status = 'leased';
    candidate.leaseOwner = owner;
    candidate.leaseGeneration += 1;
    candidate.leaseExpiresAt = new Date(now.getTime() + leaseMs);
    candidate.dispatchAttempts += 1;
    return { ...candidate, owner, generation: candidate.leaseGeneration };
  }

  async transitionAttempt(input: TransitionInput): Promise<void> {
    assertReasonCode(input.reasonCode);
    const attempt = this.attempts.get(input.attemptId);
    const outbox = this.outbox.get(input.attemptId);
    if (!attempt || !outbox) throw new Error('ATTEMPT_NOT_FOUND');
    if (
      outbox.leaseOwner !== input.leaseOwner ||
      outbox.leaseGeneration !== input.leaseGeneration
    ) {
      throw new Error('STALE_LEASE');
    }
    const caseRecord = this.cases.get(attempt.caseId)!;
    if (caseRecord.version !== input.expectedCaseVersion) throw new Error('STALE_CASE_VERSION');

    const fromState = attempt.state;
    caseRecord.version += 1;
    caseRecord.state = input.to;
    attempt.state = input.to;
    this.transitions.push({
      id: randomUUID(),
      caseId: caseRecord.id,
      attemptId: attempt.id,
      fromState,
      toState: input.to,
      caseVersion: caseRecord.version,
      reasonCode: input.reasonCode,
      createdAt: new Date(),
    });
  }

  async recordDispatchFailure(input: DispatchFailureInput): Promise<void> {
    assertReasonCode(input.reasonCode);
    const outbox = [...this.outbox.values()].find((row) => row.id === input.outboxId);
    if (!outbox) throw new Error('OUTBOX_NOT_FOUND');
    if (
      outbox.leaseOwner !== input.leaseOwner ||
      outbox.leaseGeneration !== input.leaseGeneration
    ) {
      throw new Error('STALE_LEASE');
    }
    const attempt = this.attempts.get(outbox.attemptId)!;
    const caseRecord = this.cases.get(attempt.caseId)!;
    const fromState = attempt.state;
    const exhausted = outbox.dispatchAttempts >= this.maxDispatchAttempts;
    const retry = input.classification === 'retryable' && !exhausted;
    const nextState: CaseState = retry ? 'retry_wait' : 'recoverable_failure';

    caseRecord.version += 1;
    caseRecord.state = nextState;
    attempt.state = nextState;
    this.transitions.push({
      id: randomUUID(),
      caseId: caseRecord.id,
      attemptId: attempt.id,
      fromState,
      toState: nextState,
      caseVersion: caseRecord.version,
      reasonCode: input.reasonCode,
      createdAt: input.now,
    });
    outbox.status = retry ? 'pending' : 'failed';
    outbox.reasonCode = input.reasonCode;
    outbox.nextAttemptAt = retry
      ? new Date(input.now.getTime() + 1000 * 2 ** outbox.dispatchAttempts)
      : input.now;
    delete outbox.leaseOwner;
    delete outbox.leaseExpiresAt;
  }

  getAttempt(id: string): AttemptRecord | undefined {
    return this.attempts.get(id);
  }

  snapshot(): {
    cases: CaseRecord[];
    attempts: AttemptRecord[];
    transitions: CaseTransition[];
    outbox: OutboxRecord[];
  } {
    return {
      cases: [...this.cases.values()],
      attempts: [...this.attempts.values()],
      transitions: [...this.transitions],
      outbox: [...this.outbox.values()],
    };
  }
}

export class PgCaseRepository {
  constructor(
    private readonly pool: Pool,
    private readonly options: RepositoryOptions = {},
  ) {}

  async acceptDelivery(input: IncidentDeliveryInput): Promise<AcceptedDelivery> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `INSERT INTO incident_deliveries
          (source, delivery_id, source_incident_id, redacted_payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING delivery_id`,
        [input.source, input.deliveryId, input.sourceIncidentId, input.redactedPayload],
      );
      if (claimed.rowCount === 0) {
        const existing = await client.query<{ case_id: string; attempt_id: string }>(
          `SELECT case_id, attempt_id FROM incident_deliveries
           WHERE source = $1 AND delivery_id = $2`,
          [input.source, input.deliveryId],
        );
        await client.query('COMMIT');
        const row = existing.rows[0];
        if (!row?.case_id || !row.attempt_id) throw new Error('DELIVERY_INCOMPLETE');
        return { caseId: row.case_id, attemptId: row.attempt_id, duplicate: true };
      }

      const caseId = randomUUID();
      const attemptId = randomUUID();
      const selectedCase = await client.query<{ id: string; state: CaseState; version: number }>(
        `INSERT INTO incident_cases (id, source, source_incident_id, state, version)
         VALUES ($1, $2, $3, 'queued', 1)
         ON CONFLICT (source, source_incident_id) DO UPDATE
           SET version = incident_cases.version + 1, state = 'queued', updated_at = now()
         RETURNING id, state, version`,
        [caseId, input.source, input.sourceIncidentId],
      );
      const caseRow = selectedCase.rows[0]!;
      await client.query(
        `INSERT INTO incident_attempts
          (id, case_id, delivery_source, delivery_id, state)
         VALUES ($1, $2, $3, $4, 'queued')`,
        [attemptId, caseRow.id, input.source, input.deliveryId],
      );
      await client.query(
        `UPDATE incident_deliveries SET case_id = $3, attempt_id = $4
         WHERE source = $1 AND delivery_id = $2`,
        [input.source, input.deliveryId, caseRow.id, attemptId],
      );
      await this.insertTransition(client, {
        caseId: caseRow.id,
        attemptId,
        fromState: caseRow.version === 1 ? null : caseRow.state,
        toState: 'queued',
        caseVersion: caseRow.version,
        reasonCode: 'DELIVERY_ACCEPTED',
      });
      await client.query(
        `INSERT INTO incident_outbox (id, kind, attempt_id, status)
         VALUES ($1, 'start_workflow', $2, 'pending')`,
        [randomUUID(), attemptId],
      );
      await client.query('COMMIT');
      return { caseId: caseRow.id, attemptId, duplicate: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNext(owner: string, now: Date, leaseMs: number): Promise<OutboxLease | null> {
    const result = await this.pool.query<{
      id: string;
      kind: 'start_workflow' | 'resume_workflow';
      attempt_id: string;
      status: 'leased';
      dispatch_attempts: number;
      next_attempt_at: Date;
      lease_generation: number;
      lease_expires_at: Date;
    }>(
      `WITH candidate AS (
        SELECT id FROM incident_outbox
        WHERE next_attempt_at <= $1
          AND (status = 'pending' OR (status = 'leased' AND lease_expires_at <= $1))
        ORDER BY next_attempt_at, created_at
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE incident_outbox o SET
        status = 'leased', lease_owner = $2,
        lease_generation = lease_generation + 1,
        lease_expires_at = $1 + ($3 * interval '1 millisecond'),
        dispatch_attempts = dispatch_attempts + 1,
        updated_at = now()
      FROM candidate WHERE o.id = candidate.id
      RETURNING o.*`,
      [now, owner, leaseMs],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      attemptId: row.attempt_id,
      status: row.status,
      dispatchAttempts: row.dispatch_attempts,
      nextAttemptAt: row.next_attempt_at,
      leaseOwner: owner,
      leaseGeneration: row.lease_generation,
      leaseExpiresAt: row.lease_expires_at,
      owner,
      generation: row.lease_generation,
    };
  }

  async transitionAttempt(input: TransitionInput): Promise<void> {
    assertReasonCode(input.reasonCode);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{
        case_id: string;
        state: CaseState;
        version: number;
      }>(
        `SELECT a.case_id, a.state, c.version
         FROM incident_attempts a
         JOIN incident_cases c ON c.id = a.case_id
         JOIN incident_outbox o ON o.attempt_id = a.id
         WHERE a.id = $1 AND o.lease_owner = $2 AND o.lease_generation = $3
         FOR UPDATE OF a, c, o`,
        [input.attemptId, input.leaseOwner, input.leaseGeneration],
      );
      const row = selected.rows[0];
      if (!row) throw new Error('STALE_LEASE');
      if (row.version !== input.expectedCaseVersion) throw new Error('STALE_CASE_VERSION');

      const nextVersion = row.version + 1;
      await client.query(
        `UPDATE incident_cases SET state = $2, version = $3, updated_at = now() WHERE id = $1`,
        [row.case_id, input.to, nextVersion],
      );
      await client.query(
        `UPDATE incident_attempts SET state = $2, updated_at = now() WHERE id = $1`,
        [input.attemptId, input.to],
      );
      await this.insertTransition(client, {
        caseId: row.case_id,
        attemptId: input.attemptId,
        fromState: row.state,
        toState: input.to,
        caseVersion: nextVersion,
        reasonCode: input.reasonCode,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async purgeExpiredDeliveryPayloads(cutoff: Date): Promise<number> {
    const result = await this.pool.query(
      `UPDATE incident_deliveries SET redacted_payload = NULL
       WHERE created_at < $1 AND redacted_payload IS NOT NULL`,
      [cutoff],
    );
    return result.rowCount ?? 0;
  }

  private async insertTransition(
    client: PoolClient,
    transition: Omit<CaseTransition, 'id' | 'createdAt'>,
  ): Promise<void> {
    assertReasonCode(transition.reasonCode);
    await client.query(
      `INSERT INTO incident_case_transitions
        (id, case_id, attempt_id, from_state, to_state, case_version, reason_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        transition.caseId,
        transition.attemptId,
        transition.fromState,
        transition.toState,
        transition.caseVersion,
        transition.reasonCode,
      ],
    );
  }
}
