import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const timeoutMs = 15_000;
const outputLimit = 64 * 1024;

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stop(child: ChildProcess, exited: Promise<void>): Promise<void> {
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    delay(10_000).then(() => {
      throw new Error('Generated server did not stop after SIGTERM');
    }),
  ]);
}

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${String(port)}`;
const child = spawn(process.execPath, ['.mastra/output/role.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:1/incident_triage',
    HOST: '127.0.0.1',
    INCIDENT_TEST_STORAGE: 'in-memory',
    PORT: String(port),
    PROCESS_ROLE: 'api',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-outputLimit);
  });
}
const exited = new Promise<void>((resolve, reject) => {
  child.once('exit', (code, signal) => {
    if (code === 0 || signal === 'SIGTERM') resolve();
    else
      reject(new Error(`Server exited code=${String(code)} signal=${String(signal)}\n${output}`));
  });
});

try {
  const deadline = Date.now() + timeoutMs;
  let healthy = false;
  while (Date.now() < deadline && !healthy) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      healthy = response.ok;
      await response.body?.cancel();
    } catch {
      await Promise.race([delay(100), exited]);
    }
  }
  if (!healthy) throw new Error(`Server did not become live\n${output}`);

  const readiness = await fetch(`${baseUrl}/readyz`);
  if (readiness.status !== 503) {
    throw new Error(`Expected unmigrated readiness 503, received ${String(readiness.status)}`);
  }
  await readiness.body?.cancel();

  const protectedResponse = await fetch(`${baseUrl}/api/agents`);
  if (protectedResponse.status !== 401) {
    throw new Error(`Expected protected API 401, received ${String(protectedResponse.status)}`);
  }
  await protectedResponse.body?.cancel();

  await stop(child, exited);
  console.log('Generated server passed liveness, readiness, auth, and SIGTERM probes.');
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
