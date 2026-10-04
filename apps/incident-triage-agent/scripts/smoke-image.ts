import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const suffix = randomUUID().slice(0, 8);
const network = `incident-triage-smoke-${suffix}`;
const postgres = `${network}-postgres`;
const api = `${network}-api`;
const worker = `${network}-worker`;
const image = process.env.IMAGE_NAME ?? 'mastra-agents/incident-triage-agent:local';
const databaseUrl = 'postgresql://postgres:postgres@postgres:5432/incident_triage';
const appEnvironment = [
  '-e',
  'MODEL_ID=openai/gpt-4o-mini',
  '-e',
  `DATABASE_URL=${databaseUrl}`,
  '-e',
  'INCIDENT_HMAC_SECRET=smoke-secret-with-at-least-32-characters',
  '-e',
  'JWT_ISSUER=https://identity.example.com/',
  '-e',
  'JWT_AUDIENCE=incident-triage-agent',
  '-e',
  'JWT_JWKS_URL=https://identity.example.com/.well-known/jwks.json',
];

async function docker(...args: string[]): Promise<string> {
  const result = await exec('docker', args, { maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await docker('exec', postgres, 'pg_isready', '-U', 'postgres', '-d', 'incident_triage');
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error('Postgres did not become healthy');
}

async function waitForReady(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      if (response.ok) return;
      await response.body?.cancel();
    } catch {
      // The API container may still be starting.
    }
    await delay(250);
  }
  throw new Error('API did not become ready');
}

async function boundedLogs(container: string): Promise<string> {
  try {
    return (await docker('logs', '--tail', '100', container)).slice(-16 * 1024);
  } catch {
    return '';
  }
}

try {
  await docker('network', 'create', network);
  await docker(
    'run',
    '-d',
    '--name',
    postgres,
    '--network',
    network,
    '--network-alias',
    'postgres',
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-e',
    'POSTGRES_DB=incident_triage',
    'postgres:17-alpine',
  );
  await waitForPostgres();

  await docker(
    'run',
    '--rm',
    '--network',
    network,
    ...appEnvironment,
    '-e',
    'PROCESS_ROLE=migrate',
    image,
  );

  await docker(
    'run',
    '-d',
    '--name',
    api,
    '--network',
    network,
    '-p',
    '127.0.0.1::4111',
    ...appEnvironment,
    '-e',
    'PROCESS_ROLE=api',
    image,
  );
  const mapping = await docker('port', api, '4111/tcp');
  const port = mapping.match(/:(\d+)$/u)?.[1];
  if (!port) throw new Error(`Unable to parse API port mapping: ${mapping}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl);

  const protectedResponse = await fetch(`${baseUrl}/api/agents`);
  if (protectedResponse.status !== 401) {
    throw new Error(`Expected protected API 401, received ${String(protectedResponse.status)}`);
  }
  await protectedResponse.body?.cancel();
  if ((await docker('inspect', '--format', '{{.Config.User}}', api)) !== 'node') {
    throw new Error('API image is not configured to run as node');
  }
  await docker('exec', api, 'sh', '-c', 'test ! -e /app/src && test ! -e /app/.env');

  await docker(
    'run',
    '-d',
    '--name',
    worker,
    '--network',
    network,
    ...appEnvironment,
    '-e',
    'PROCESS_ROLE=worker',
    image,
  );
  await delay(1000);
  if ((await docker('inspect', '--format', '{{.State.Running}}', worker)) !== 'true') {
    throw new Error('Worker role did not remain running');
  }
  await docker('stop', '--time', '10', worker);
  const workerExit = await docker('inspect', '--format', '{{.State.ExitCode}}', worker);
  if (workerExit !== '0') throw new Error(`Worker exited with ${workerExit}`);

  console.log('Image smoke passed API, migration, worker, non-root, auth, and shutdown probes.');
} catch (error) {
  const logs = await Promise.all([boundedLogs(api), boundedLogs(worker), boundedLogs(postgres)]);
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\n${logs.filter(Boolean).join('\n')}`,
  );
} finally {
  await exec('docker', ['rm', '-f', api, worker, postgres]).catch(() => undefined);
  await exec('docker', ['network', 'rm', network]).catch(() => undefined);
}
