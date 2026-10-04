import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgEvidenceLedger } from '../../src/evidence/ledger.js';
import { applyMigrations } from '../../src/persistence/migrate.js';
import { PgCaseRepository } from '../../src/persistence/repositories/case-repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('Postgres evidence ledger', () => {
  const schema = `evidence_test_${randomUUID().replaceAll('-', '')}`;
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

  it('deduplicates immutable content, appends observations, and seals once', async () => {
    const cases = new PgCaseRepository(pool);
    const firstAttempt = await cases.acceptDelivery({
      source: 'fixture',
      deliveryId: randomUUID(),
      sourceIncidentId: 'evidence-pg',
      redactedPayload: { summary: 'error rate' },
    });
    const secondAttempt = await cases.acceptDelivery({
      source: 'fixture',
      deliveryId: randomUUID(),
      sourceIncidentId: 'evidence-pg',
      redactedPayload: { summary: 'error rate updated' },
    });
    const ledger = new PgEvidenceLedger(pool);
    const input = {
      source: 'metrics',
      sourceTier: 'primary' as const,
      sourceLocator: 'metrics/api/errors',
      observedAt: '2026-10-03T18:00:00.000Z',
      collectorVersion: 'fixture/v1',
      redactionVersion: 'redaction/v1',
      canonicalizationVersion: 'canonical-json/v1' as const,
      freshness: 'fresh' as const,
      collectionStatus: 'complete' as const,
      normalizedPayload: { status: 'degraded', value: 3, unit: 'errors_per_second' },
    };

    const first = await ledger.record(firstAttempt.attemptId, input);
    const second = await ledger.record(secondAttempt.attemptId, input);
    expect(second.evidenceId).toBe(first.evidenceId);
    expect(await ledger.seal(firstAttempt.attemptId)).toMatchObject({
      attemptId: firstAttempt.attemptId,
      items: [{ evidenceId: first.evidenceId }],
    });
    await expect(ledger.seal(firstAttempt.attemptId)).rejects.toThrow('MANIFEST_ALREADY_SEALED');

    const counts = await pool.query<{ content: number; observations: number }>(
      `SELECT
        (SELECT count(*)::integer FROM incident_evidence_content) AS content,
        (SELECT count(*)::integer FROM incident_evidence_observations) AS observations`,
    );
    expect(counts.rows[0]).toEqual({ content: 1, observations: 2 });
  });
});
