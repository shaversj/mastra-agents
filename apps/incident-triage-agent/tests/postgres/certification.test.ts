import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCertificationDecision } from '../../src/certification/certification.js';
import { createDecisionCapsule } from '../../src/certification/capsule.js';
import { applyMigrations } from '../../src/persistence/migrate.js';
import { PgCaseRepository } from '../../src/persistence/repositories/case-repository.js';
import { PgCertificationRepository } from '../../src/persistence/repositories/certification-repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('Postgres certification records', () => {
  const schema = `certification_test_${randomUUID().replaceAll('-', '')}`;
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

  it('persists only the capsule and final human decision in app storage', async () => {
    const accepted = await new PgCaseRepository(pool).acceptDelivery({
      source: 'fixture',
      deliveryId: randomUUID(),
      sourceIncidentId: 'certification',
      redactedPayload: { summary: 'errors' },
    });
    const capsule = createDecisionCapsule({
      attemptId: accepted.attemptId,
      normalizedIncident: { service: 'api' },
      manifestId: 'manifest',
      manifestDigest: 'digest',
      manifestItems: [],
      model: { provider: 'mock', modelId: 'candidate', settings: {} },
      versions: {
        prompt: 'v1',
        schema: 'v1',
        policy: 'v1',
        catalog: 'v1',
        redaction: 'v1',
        collector: 'v1',
        applicationBuild: 'v1',
        mastra: '1.74.0',
      },
      structuredResult: {},
      validationOutcomes: { gate: true },
      mastraRefs: { workflowRunId: 'run-1', gateResultId: 'mastra-score-1' },
    });
    const decision = createCertificationDecision({
      candidateBundle: 'candidate/v1',
      datasetVersion: 'dataset/v1',
      experiments: [
        {
          experimentId: 'experiment-1',
          status: 'completed',
          itemScores: [{ itemId: 'item-1', score: 1, failedSubchecks: [] }],
        },
      ],
      gateRevision: 'gate/v1',
      reviewerId: 'reviewer',
      decision: 'certified',
      reason: 'All deterministic gates passed and explanations were reviewed.',
    });
    const repository = new PgCertificationRepository(pool);
    await repository.saveCapsule(capsule);
    await repository.saveDecision(decision);

    const counts = await pool.query<{ capsules: number; decisions: number }>(
      `SELECT
        (SELECT count(*)::integer FROM incident_decision_capsules) AS capsules,
        (SELECT count(*)::integer FROM incident_certification_decisions) AS decisions`,
    );
    expect(counts.rows[0]).toEqual({ capsules: 1, decisions: 1 });
  });
});
