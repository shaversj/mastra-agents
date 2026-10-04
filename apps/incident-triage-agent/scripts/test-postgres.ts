import { spawn } from 'node:child_process';

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for Postgres tests');

const child = spawn('pnpm', ['exec', 'vitest', 'run', 'tests/postgres'], {
  env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
  stdio: 'inherit',
});
const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
if (code !== 0) process.exitCode = code ?? 1;
