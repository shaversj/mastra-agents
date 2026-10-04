import { Pool } from 'pg';

import type { AppConfig } from '../config/app.js';

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
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
