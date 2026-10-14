import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { parseActionInputs } from './inputs.js';
import { createLiveActionDependencies } from './live-runtime.js';
import {
  createSafeActionObserver,
  isSafeReasonCode,
  runTriageAction,
  type ActionControllerDependencies,
  type ActionRequest,
  type ActionResult,
  type RoutingSnapshot,
} from './run.js';
import { appMetadata } from '../config/app.js';
import { defaultLifecycleLabels } from '../domain/lifecycle.js';

type Environment = Record<string, string | undefined>;

const secretInputNames = [
  'INPUT_ANTHROPIC-API-KEY',
  'INPUT_ANTHROPIC_API_KEY',
  'INPUT_CLOUDFLARE-ACCOUNT-ID',
  'INPUT_CLOUDFLARE-API-KEY',
  'INPUT_CLOUDFLARE_ACCOUNT_ID',
  'INPUT_CLOUDFLARE_API_KEY',
  'INPUT_OPENAI-API-KEY',
  'INPUT_OPENAI_API_KEY',
  'INPUT_READ-TOKEN',
  'INPUT_READ_TOKEN',
  'INPUT_WRITE-TOKEN',
  'INPUT_WRITE_TOKEN',
] as const;

export interface NormalizedActionEnvironment {
  dispose(): void;
  values: Environment;
}

export interface ActionEntrypointOptions {
  dependencies?: ActionControllerDependencies;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
}

function normalizedEnvironment(environment: Environment): NormalizedActionEnvironment {
  const values: Environment = {};
  for (const [name, raw] of Object.entries(environment)) {
    values[name] = typeof raw === 'string' ? raw.trim() : raw;
  }
  for (const name of secretInputNames) {
    if (name in environment) Reflect.deleteProperty(environment, name);
  }
  return {
    dispose() {
      for (const name of secretInputNames) values[name] = undefined;
    },
    values,
  };
}

function requiredEnvironment(environment: Environment, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`ACTION_${name}_MISSING`);
  return value;
}

function eventName(environment: Environment): ActionRequest['eventName'] {
  const value = requiredEnvironment(environment, 'GITHUB_EVENT_NAME');
  if (value !== 'issues' && value !== 'issue_comment') throw new Error('ACTION_EVENT_UNSUPPORTED');
  return value;
}

function workflowRunId(environment: Environment): number {
  const value = Number(requiredEnvironment(environment, 'GITHUB_RUN_ID'));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('ACTION_RUN_ID_INVALID');
  return value;
}

function workflowRunAttempt(environment: Environment): number {
  const value = Number(environment.GITHUB_RUN_ATTEMPT ?? '1');
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('ACTION_RUN_ATTEMPT_INVALID');
  return value;
}

function trustedRunUrl(environment: Environment): string | undefined {
  const server = environment.GITHUB_SERVER_URL;
  const repository = environment.GITHUB_REPOSITORY;
  const runId = environment.GITHUB_RUN_ID;
  if (!server || !repository || !runId) return undefined;
  const url = new URL(`${server}/${repository}/actions/runs/${runId}`);
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  return url.toString();
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && isSafeReasonCode(error.message)) return error.message;
  return 'ACTION_FAILED';
}

async function writeOutputs(environment: Environment, result: ActionResult): Promise<void> {
  const outputPath = environment.GITHUB_OUTPUT;
  if (outputPath) {
    await appendFile(
      outputPath,
      [
        `status=${result.status}`,
        `route=${result.route}`,
        `reason-code=${result.reasonCode}`,
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
  const summaryPath = environment.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(
      summaryPath,
      [
        '### Mastra triage agent',
        '',
        `- Status: ${result.status}`,
        `- Route: ${result.route}`,
        `- Reason: ${result.reasonCode}`,
        `- Issue: ${result.issueNumber}`,
        ...(result.runUrl ? [`- Run: ${result.runUrl}`] : []),
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
}

interface FixtureTransport {
  mode: 'duplicate';
}

async function fixtureDependencies(
  path: string,
  captured: Environment,
): Promise<ActionControllerDependencies> {
  const fixture = JSON.parse(await readFile(path, 'utf8')) as FixtureTransport;
  if (fixture.mode !== 'duplicate') throw new Error('ACTION_FIXTURE_INVALID');
  const unavailable = async (): Promise<never> => {
    throw new Error('ACTION_FIXTURE_UNEXPECTED_BOUNDARY');
  };
  return {
    acquireLease: unavailable,
    createModelRuntime: unavailable,
    executeRoute: unavailable,
    inspectModelCapabilities: unavailable,
    loadModelInputs: async () => parseActionInputs(captured),
    observer: createSafeActionObserver(() => undefined),
    readRoutingState: async (event): Promise<RoutingSnapshot> => ({
      activationPolicy: 'automatic-public',
      botLogins: ['github-actions[bot]'],
      branchProvenanceVerified: false,
      githubIdentityVerified: false,
      ledger: {
        failureCount: 0,
        generation: 0,
        modelEventCount: 0,
        processedEventFingerprints: [event.eventFingerprint],
      },
      lifecycleLabels: defaultLifecycleLabels,
      maxModelEvents: 4,
    }),
    reconcile: unavailable,
  };
}

async function resolveDependencies(
  environment: Environment,
  injected?: ActionControllerDependencies,
): Promise<ActionControllerDependencies> {
  if (injected) return injected;
  const fixturePath = environment.TRIAGE_ACTION_FAKE_TRANSPORT;
  if (fixturePath) return fixtureDependencies(fixturePath, environment);
  return createLiveActionDependencies({ environment, inputs: parseActionInputs(environment) });
}

export async function runAction(
  environment: Environment = process.env,
  options: ActionEntrypointOptions = {},
): Promise<ActionResult> {
  const normalized = normalizedEnvironment(environment);
  const abortController = new AbortController();
  const onTermination = () => abortController.abort();
  process.once('SIGTERM', onTermination);
  try {
    const eventPath = requiredEnvironment(normalized.values, 'GITHUB_EVENT_PATH');
    const payload = JSON.parse(await readFile(eventPath, 'utf8')) as unknown;
    const dependencies = await resolveDependencies(normalized.values, options.dependencies);
    const runId = workflowRunId(normalized.values);
    const runUrl = trustedRunUrl(normalized.values);
    const result = await runTriageAction(
      {
        abortSignal: abortController.signal,
        deliveryId:
          normalized.values.GITHUB_DELIVERY ??
          `${runId}:${normalized.values.GITHUB_RUN_ATTEMPT ?? '1'}`,
        eventName: eventName(normalized.values),
        payload,
        ...(runUrl ? { runUrl } : {}),
        workflowRunId: runId,
        workflowRunAttempt: workflowRunAttempt(normalized.values),
      },
      dependencies,
    );
    await writeOutputs(normalized.values, result);
    (options.stdout ?? process.stdout).write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    process.removeListener('SIGTERM', onTermination);
    normalized.dispose();
  }
}

async function main(): Promise<void> {
  try {
    await runAction();
  } catch (error) {
    const result = {
      appId: appMetadata.appId,
      reasonCode: safeErrorCode(error),
      status: 'failed',
    };
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
