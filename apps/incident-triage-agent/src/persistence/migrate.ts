import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Pool } from 'pg';

export interface Migration {
  id: string;
  sql: string;
}

export const migrationIds = [
  '001_case_engine',
  '002_evidence_ledger',
  '003_resume_permits',
  '004_decision_certification',
] as const;

async function defaultMigrations(): Promise<Migration[]> {
  const baseUrl = process.env.APP_MIGRATIONS_DIR
    ? pathToFileURL(`${resolve(process.env.APP_MIGRATIONS_DIR)}/`)
    : new URL('./migrations/', import.meta.url);
  return Promise.all(
    migrationIds.map(async (id) => ({
      id,
      sql: await readFile(new URL(`${id}.sql`, baseUrl), 'utf8'),
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
