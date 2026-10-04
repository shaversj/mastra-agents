import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from '../../src/persistence/migrate.js';
import { PgCaseRepository } from '../../src/persistence/repositories/case-repository.js';
import { loadWorkflowInput } from '../../src/worker/input.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('worker workflow input', () => {
  const schema = `worker_input_test_${randomUUID().replaceAll('-', '')}`;
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

  it('seals accepted delivery evidence before starting a workflow', async () => {
    const repository = new PgCaseRepository(pool);
    const accepted = await repository.acceptDelivery({
      source: 'fixture',
      deliveryId: randomUUID(),
      sourceIncidentId: 'worker-input',
      redactedPayload: { service: 'checkout-api', summary: 'dependency timeout' },
    });

    const first = await loadWorkflowInput(pool, accepted.attemptId);
    const second = await loadWorkflowInput(pool, accepted.attemptId);

    expect(first.manifest.items).toHaveLength(1);
    expect(first.manifest.items[0]).toMatchObject({ source: 'fixture', sourceTier: 'primary' });
    expect(second.manifest).toEqual(first.manifest);
  });
});
