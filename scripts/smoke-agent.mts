import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const containerPort = 4111;
const defaultStartupTimeoutMs = 30_000;
const defaultRequestTimeoutMs = 2_000;
const defaultShutdownTimeoutSeconds = 10;
const defaultLogLimitBytes = 64 * 1024;
const commandOutputLimitBytes = 128 * 1024;
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface SmokeDependencies {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  randomUUID: () => string;
  runDocker: (arguments_: string[], timeoutMs?: number) => Promise<CommandResult>;
  sleep: (milliseconds: number) => Promise<void>;
}

export interface SmokeOptions {
  appName: string;
  image: string;
  logLimitBytes?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutSeconds?: number;
  startupTimeoutMs?: number;
}

interface AppMetadata {
  agentId: string;
  appId: string;
  packageName: string;
}

interface ContainerState {
  ExitCode: number;
  OOMKilled: boolean;
  Status: string;
}

function runDocker(arguments_: string[], timeoutMs = 15_000): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      'docker',
      arguments_,
      {
        encoding: 'utf8',
        maxBuffer: commandOutputLimitBytes,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectCommand(
            new Error(
              `docker ${arguments_[0] ?? 'command'} failed: ${error.message}${stderr ? `\n${stderr}` : ''}`,
            ),
          );
          return;
        }

        resolveCommand({ stdout, stderr });
      },
    );
  });
}

const defaultDependencies: SmokeDependencies = {
  fetch: (url, init) => fetch(url, init),
  now: Date.now,
  randomUUID,
  runDocker,
  sleep: async (milliseconds) => sleep(milliseconds),
};

function requireIntegerInRange(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return value;
}

async function loadAppMetadata(appName: string): Promise<AppMetadata> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(appName)) {
    throw new Error('appName must be a lowercase workspace directory name');
  }

  const configUrl = pathToFileURL(
    resolve(repositoryRoot, 'apps', appName, 'src', 'config', 'app.ts'),
  ).href;
  const module: unknown = await import(configUrl);

  if (
    typeof module !== 'object' ||
    module === null ||
    !('appMetadata' in module) ||
    typeof module.appMetadata !== 'object' ||
    module.appMetadata === null
  ) {
    throw new Error(`Unable to load app-owned metadata for ${appName}`);
  }

  const metadata = module.appMetadata as Record<string, unknown>;
  if (
    typeof metadata.agentId !== 'string' ||
    typeof metadata.appId !== 'string' ||
    typeof metadata.packageName !== 'string' ||
    metadata.appId !== appName
  ) {
    throw new Error(`Invalid app-owned metadata for ${appName}`);
  }

  return {
    agentId: metadata.agentId,
    appId: metadata.appId,
    packageName: metadata.packageName,
  };
}

function parsePublishedPort(output: string): number {
  const matches = output.trim().split('\n').filter(Boolean);
  if (matches.length !== 1) {
    throw new Error(`Docker returned an unexpected port mapping: ${output.trim()}`);
  }

  const match = /^127\.0\.0\.1:(\d+)$/.exec(matches[0] ?? '');
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Docker did not publish the container on loopback: ${output.trim()}`);
  }
  return port;
}

function parseContainerState(output: string): ContainerState {
  let state: unknown;
  try {
    state = JSON.parse(output);
  } catch {
    throw new Error('Docker returned an invalid container state');
  }

  if (
    typeof state !== 'object' ||
    state === null ||
    !('Status' in state) ||
    !('ExitCode' in state) ||
    !('OOMKilled' in state) ||
    typeof state.Status !== 'string' ||
    typeof state.ExitCode !== 'number' ||
    typeof state.OOMKilled !== 'boolean'
  ) {
    throw new Error('Docker returned an incomplete container state');
  }

  return {
    Status: state.Status,
    ExitCode: state.ExitCode,
    OOMKilled: state.OOMKilled,
  };
}

function truncateLogs(logs: string, limitBytes: number): string {
  const buffer = Buffer.from(logs);
  if (buffer.byteLength <= limitBytes) {
    return logs;
  }

  return `[earlier container logs truncated]\n${buffer.subarray(buffer.byteLength - limitBytes).toString()}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForHealth(
  baseUrl: string,
  startupTimeoutMs: number,
  requestTimeoutMs: number,
  dependencies: SmokeDependencies,
): Promise<void> {
  const deadline = dependencies.now() + startupTimeoutMs;

  while (dependencies.now() < deadline) {
    const remainingMs = deadline - dependencies.now();
    try {
      const response = await dependencies.fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs, Math.max(1, remainingMs))),
      });
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
      } else {
        await response.body?.cancel();
      }
    } catch {
      // The container may need a moment before it accepts connections.
    }

    await dependencies.sleep(Math.min(100, Math.max(1, remainingMs)));
  }

  throw new Error(`container did not become healthy within ${String(startupTimeoutMs)}ms`);
}

async function assertExpectedAgent(
  baseUrl: string,
  expectedAgentId: string,
  requestTimeoutMs: number,
  dependencies: SmokeDependencies,
): Promise<void> {
  const response = await dependencies.fetch(`${baseUrl}/api/agents`, {
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`/api/agents returned HTTP ${String(response.status)}`);
  }

  const agents: unknown = await response.json();
  if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) {
    throw new Error('/api/agents did not return an agent registry object');
  }

  const agentIds = Object.keys(agents);
  if (agentIds.length !== 1 || agentIds[0] !== expectedAgentId) {
    throw new Error(`/api/agents returned unexpected agent ids: ${agentIds.join(', ')}`);
  }
}

export async function smokeAgent(
  options: SmokeOptions,
  dependencies: SmokeDependencies = defaultDependencies,
): Promise<{ agentId: string; port: number }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/.test(options.image)) {
    throw new Error('image must be a valid bounded Docker image reference');
  }

  const startupTimeoutMs = requireIntegerInRange(
    options.startupTimeoutMs ?? defaultStartupTimeoutMs,
    'startupTimeoutMs',
    100,
    120_000,
  );
  const requestTimeoutMs = requireIntegerInRange(
    options.requestTimeoutMs ?? defaultRequestTimeoutMs,
    'requestTimeoutMs',
    100,
    10_000,
  );
  const shutdownTimeoutSeconds = requireIntegerInRange(
    options.shutdownTimeoutSeconds ?? defaultShutdownTimeoutSeconds,
    'shutdownTimeoutSeconds',
    1,
    10,
  );
  const logLimitBytes = requireIntegerInRange(
    options.logLimitBytes ?? defaultLogLimitBytes,
    'logLimitBytes',
    1024,
    defaultLogLimitBytes,
  );
  const metadata = await loadAppMetadata(options.appName);
  const containerName = `mastra-smoke-${metadata.appId}-${dependencies.randomUUID().slice(0, 8)}`;
  let containerStarted = false;
  let publishedPort: number | undefined;
  let failure: unknown;

  try {
    await dependencies.runDocker([
      'run',
      '--detach',
      '--name',
      containerName,
      '--publish',
      `127.0.0.1::${String(containerPort)}`,
      '--env',
      'MODEL_ID=openai/gpt-4o-mini',
      '--env',
      'HOST=0.0.0.0',
      '--env',
      `PORT=${String(containerPort)}`,
      options.image,
    ]);
    containerStarted = true;

    const portResult = await dependencies.runDocker([
      'port',
      containerName,
      `${String(containerPort)}/tcp`,
    ]);
    publishedPort = parsePublishedPort(portResult.stdout);
    const baseUrl = `http://127.0.0.1:${String(publishedPort)}`;

    await waitForHealth(baseUrl, startupTimeoutMs, requestTimeoutMs, dependencies);
    await assertExpectedAgent(baseUrl, metadata.agentId, requestTimeoutMs, dependencies);
  } catch (error) {
    failure = error;
  }

  if (containerStarted) {
    try {
      await dependencies.runDocker(
        ['stop', '--time', String(shutdownTimeoutSeconds), containerName],
        (shutdownTimeoutSeconds + 2) * 1000,
      );
      const stateResult = await dependencies.runDocker([
        'inspect',
        '--format',
        '{{json .State}}',
        containerName,
      ]);
      const state = parseContainerState(stateResult.stdout);
      if (state.Status !== 'exited' || state.ExitCode !== 0 || state.OOMKilled) {
        throw new Error(
          `container did not exit cleanly after SIGTERM (status=${state.Status}, exitCode=${String(state.ExitCode)}, oomKilled=${String(state.OOMKilled)})`,
        );
      }
    } catch (error) {
      failure ??= error;
    }
  }

  let logs = '';
  if (failure && containerStarted) {
    try {
      const logResult = await dependencies.runDocker(['logs', '--tail', '200', containerName]);
      logs = truncateLogs(`${logResult.stdout}${logResult.stderr}`, logLimitBytes);
    } catch (error) {
      logs = `[unable to read container logs: ${describeError(error)}]`;
    }
  }

  try {
    await dependencies.runDocker(['rm', '--force', containerName]);
  } catch (error) {
    failure ??= error;
  }

  if (failure) {
    throw new Error(
      `Image smoke failed for ${metadata.agentId}: ${describeError(failure)}${logs ? `\nContainer logs:\n${logs}` : ''}`,
    );
  }

  if (publishedPort === undefined) {
    throw new Error(`Image smoke failed for ${metadata.agentId}: Docker did not publish a port`);
  }

  return { agentId: metadata.agentId, port: publishedPort };
}

function readRequiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await smokeAgent({
    appName: readRequiredArgument('--app'),
    image: readRequiredArgument('--image'),
  });
  console.log(
    `Image passed model-free probes on loopback for ${result.agentId} and exited cleanly after SIGTERM`,
  );
}
