import { Pool } from 'pg';

import { applyMigrations } from '../src/persistence/migrate.js';

export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('Missing required environment variable: DATABASE_URL');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await applyMigrations(pool);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await runMigrations();
}
