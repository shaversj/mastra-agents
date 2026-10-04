import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from '../../src/persistence/migrate.js';
import { PgCaseRepository } from '../../src/persistence/repositories/case-repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('Postgres case engine', () => {
  const schema = `incident_test_${randomUUID().replaceAll('-', '')}`;
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

  afterEach(async () => {
    await pool.query("UPDATE incident_outbox SET status = 'completed'");
  });

  it('accepts one attempt for concurrent duplicate delivery', async () => {
    const repository = new PgCaseRepository(pool);
    const input = {
      source: 'recorded',
      deliveryId: randomUUID(),
      sourceIncidentId: 'incident-pg-1',
      redactedPayload: { summary: 'latency' },
    };
    const [first, second] = await Promise.all([
      repository.acceptDelivery(input),
      repository.acceptDelivery(input),
    ]);

    expect(second).toMatchObject({ caseId: first.caseId, attemptId: first.attemptId });
    const counts = await pool.query<{ attempts: string; outbox: string }>(
      `SELECT
        (SELECT count(*) FROM incident_attempts WHERE case_id = $1)::text AS attempts,
        (SELECT count(*) FROM incident_outbox WHERE attempt_id = $2)::text AS outbox`,
      [first.caseId, first.attemptId],
    );
    expect(counts.rows[0]).toEqual({ attempts: '1', outbox: '1' });
  });

  it('is migration-idempotent and detects checksum drift', async () => {
    await expect(applyMigrations(pool)).resolves.toBeUndefined();
    await expect(
      applyMigrations(pool, [{ id: '001_case_engine', sql: 'SELECT 1' }]),
    ).rejects.toThrow('MIGRATION_CHECKSUM_MISMATCH');
  });

  it('fences an expired lease and retains governance transitions during payload cleanup', async () => {
    const repository = new PgCaseRepository(pool);
    const accepted = await repository.acceptDelivery({
      source: 'recorded',
      deliveryId: randomUUID(),
      sourceIncidentId: 'incident-pg-fencing',
      redactedPayload: { summary: 'errors' },
    });
    const now = new Date();
    const first = await repository.claimNext('worker-a', now, 1000);
    const second = await repository.claimNext('worker-b', new Date(now.getTime() + 2000), 1000);
    if (!first) throw new Error('Expected first lease');

    await expect(
      repository.transitionAttempt({
        attemptId: accepted.attemptId,
        expectedCaseVersion: 1,
        leaseOwner: 'worker-a',
        leaseGeneration: first.generation,
        to: 'collecting_evidence',
        reasonCode: 'DISPATCHED',
      }),
    ).rejects.toThrow('STALE_LEASE');

    expect(second?.generation).toBe(2);
    await pool.query(
      `UPDATE incident_deliveries SET created_at = '2020-01-01' WHERE attempt_id = $1`,
      [accepted.attemptId],
    );
    expect(await repository.purgeExpiredDeliveryPayloads(new Date('2021-01-01'))).toBe(1);
    const governance = await pool.query(
      'SELECT count(*)::integer AS count FROM incident_case_transitions WHERE attempt_id = $1',
      [accepted.attemptId],
    );
    expect(governance.rows[0]?.count).toBe(1);
  });
});
