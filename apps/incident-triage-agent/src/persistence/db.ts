import { Pool } from 'pg';

import type { AppConfig } from '../config/app.js';
import { migrationIds } from './migrate.js';

export function createDatabasePool(config: Pick<AppConfig, 'databaseUrl'>): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    application_name: 'incident-triage-agent',
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
  });
}

export async function databaseIsReady(pool: Pool): Promise<boolean> {
  try {
    const result = await pool.query<{ complete: boolean }>(
      `SELECT count(*) = $2 AS complete
       FROM incident_schema_migrations
       WHERE id = ANY($1::text[])`,
      [migrationIds, migrationIds.length],
    );
    return result.rows[0]?.complete === true;
  } catch {
    return false;
  }
}
