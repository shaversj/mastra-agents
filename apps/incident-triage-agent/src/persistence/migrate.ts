import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Pool } from 'pg';

export interface Migration {
  id: string;
  sql: string;
}

async function defaultMigrations(): Promise<Migration[]> {
  const definitions = [
    ['001_case_engine', './migrations/001_case_engine.sql'],
    ['002_evidence_ledger', './migrations/002_evidence_ledger.sql'],
    ['003_resume_permits', './migrations/003_resume_permits.sql'],
    ['004_decision_certification', './migrations/004_decision_certification.sql'],
  ] as const;
  return Promise.all(
    definitions.map(async ([id, path]) => ({
      id,
      sql: await readFile(new URL(path, import.meta.url), 'utf8'),
    })),
  );
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function applyMigrations(pool: Pool, supplied?: Migration[]): Promise<void> {
  const migrations = supplied ?? (await defaultMigrations());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('incident-triage-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS incident_schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    for (const migration of migrations) {
      const digest = checksum(migration.sql);
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM incident_schema_migrations WHERE id = $1',
        [migration.id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== digest) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO incident_schema_migrations (id, checksum) VALUES ($1, $2)', [
        migration.id,
        digest,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
