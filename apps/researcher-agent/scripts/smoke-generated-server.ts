import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { appMetadata } from '../src/config/app.js';

const startupTimeoutMs = 10_000;
const shutdownTimeoutMs = 10_000;

async function getAvailablePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to allocate a loopback port');
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  return address.port;
}

async function waitForHealth(baseUrl: string, childExit: Promise<never>): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        const body: unknown = await response.json();
        if (
          typeof body === 'object' &&
          body !== null &&
          'success' in body &&
          body.success === true
        ) {
          return;
        }
      }
    } catch {
      // The generated process may need a moment before it accepts connections.
    }

    await Promise.race([delay(100), childExit]);
  }

  throw new Error(`Generated server did not become healthy within ${String(startupTimeoutMs)}ms`);
}

async function stopServer(
  child: ChildProcess,
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void> {
  child.kill('SIGTERM');

  const result = await Promise.race([exit, delay(shutdownTimeoutMs).then(() => undefined)]);

  if (!result) {
    child.kill('SIGKILL');
    throw new Error(
      `Generated server did not exit within ${String(shutdownTimeoutMs)}ms of SIGTERM`,
    );
  }

  if (result.code !== 0) {
    throw new Error(
      `Generated server exited unsuccessfully (code=${String(result.code)}, signal=${String(result.signal)})`,
    );
  }
}

const port = await getAvailablePort();
const baseUrl = `http://127.0.0.1:${String(port)}`;
const child = spawn(process.execPath, ['.mastra/output/index.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    MODEL_ID: 'openai/gpt-4o-mini',
    HOST: '127.0.0.1',
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk: Buffer) => {
  output += chunk.toString();
});
child.stderr.on('data', (chunk: Buffer) => {
  output += chunk.toString();
});

const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
const earlyExit = exit.then((result) => {
  throw new Error(
    `Generated server exited before the probes completed (code=${String(result.code)}, signal=${String(result.signal)})\n${output}`,
  );
});

let stopped = false;
try {
  await waitForHealth(baseUrl, earlyExit);

  const agentsResponse = await fetch(`${baseUrl}/api/agents`);
  if (!agentsResponse.ok) {
    throw new Error(`/api/agents returned HTTP ${String(agentsResponse.status)}`);
  }

  const agents: unknown = await agentsResponse.json();
  if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) {
    throw new Error('/api/agents did not return an agent registry object');
  }

  const agentIds = Object.keys(agents);
  if (agentIds.length !== 1 || agentIds[0] !== appMetadata.agentId) {
    throw new Error(`/api/agents returned unexpected agent ids: ${agentIds.join(', ')}`);
  }

  await stopServer(child, exit);
  stopped = true;
  console.log(
    `Generated server passed model-free probes on loopback for ${appMetadata.agentId} and exited after SIGTERM`,
  );
} finally {
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}
