import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { parseActionInputs } from '../src/action/inputs.js';
import {
  createSafeActionObserver,
  runTriageAction,
  type ActionControllerDependencies,
} from '../src/action/run.js';
import { defaultLifecycleLabels } from '../src/domain/lifecycle.js';
import {
  createTriageMastra,
  invokeRedactedTriageAgent,
  redactedTracingOptions,
} from '../src/mastra/index.js';

const payload = JSON.parse(
  await readFile(new URL('./fixtures/events/issue-opened.json', import.meta.url), 'utf8'),
) as { issue: { body: string; title: string } };

describe('safe Action observability', () => {
  it('records only allowlisted bounded metadata and never untrusted content or secrets', async () => {
    const canaries = [
      'ISSUE_CANARY',
      'PROVIDER_CANARY',
      'WRITE_TOKEN_CANARY',
      'MODEL_OUTPUT_CANARY',
    ];
    payload.issue.title = canaries[0] ?? 'ISSUE_CANARY';
    payload.issue.body = `${canaries[0] ?? 'ISSUE_CANARY'} malicious instructions`;
    const observations: unknown[] = [];
    const observer = createSafeActionObserver((observation) => observations.push(observation));
    const inputs = parseActionInputs({
      INPUT_ANTHROPIC_API_KEY: canaries[1],
      INPUT_READ_TOKEN: 'READ_TOKEN_CANARY',
      INPUT_TRIAGE_SKILL: '.agents/skills/triage',
      INPUT_WRITE_TOKEN: canaries[2],
    });
    const dependencies: ActionControllerDependencies = {
      acquireLease: vi.fn(async () => ({
        assertCurrent: vi.fn(async () => undefined),
        fencingToken: 'fence-1',
        release: vi.fn(async () => undefined),
      })),
      createModelRuntime: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
      executeRoute: vi.fn(async () => ({
        reasonCode: 'FIX_PROPOSED',
        state: 'fix_pending' as const,
      })),
      inspectModelCapabilities: vi.fn(async () => ({
        checkoutSafe: true,
        labelsPresent: true,
        prSkillPresent: true,
        sandboxAvailable: true,
        triageSkillPresent: true,
      })),
      loadModelInputs: vi.fn(async () => inputs),
      observer,
      readRoutingState: vi.fn(async () => ({
        activationPolicy: 'automatic-public' as const,
        botLogins: [],
        branchProvenanceVerified: true,
        githubIdentityVerified: true,
        ledger: {
          failureCount: 0,
          generation: 0,
          modelEventCount: 0,
          processedEventFingerprints: [],
        },
        lifecycleLabels: defaultLifecycleLabels,
        maxModelEvents: 4,
      })),
      reconcileFailure: vi.fn(async () => undefined),
      reconcile: vi.fn(async ({ event, route }) => ({
        appId: 'triage-agent' as const,
        issueNumber: event.issue.number,
        reasonCode: 'FIX_PROPOSED',
        repository: event.repository.fullName,
        route: route.kind,
        state: 'fix_pending' as const,
        status: 'completed' as const,
      })),
    };

    const result = await runTriageAction(
      {
        deliveryId: 'delivery-observe',
        eventName: 'issues',
        payload,
        workflowRunId: 100,
      },
      dependencies,
    );
    const publicSurface = JSON.stringify({ observations, result });

    for (const canary of canaries) expect(publicSurface).not.toContain(canary);
    expect(observations).toEqual([
      expect.objectContaining({ name: 'triage.route' }),
      expect.objectContaining({ name: 'triage.outcome' }),
    ]);
  });

  it('disables generic logging and persistent observability by default', () => {
    const createMastra = vi.fn((configuration) => configuration);

    const configuration = createTriageMastra({
      createAgent: (agentConfiguration) => agentConfiguration,
      createMastra,
      history: { blame: vi.fn(), log: vi.fn() },
      invokeModel: vi.fn(),
      model: 'fixture-model',
      workspace: {},
    });

    expect(createMastra).toHaveBeenCalledWith(
      expect.objectContaining({
        logger: false,
        loggerOptions: { correlation: false, export: false },
      }),
    );
    expect(configuration).not.toHaveProperty('observability');
  });

  it('hides input and output on every registered-agent model call', async () => {
    const generate = vi.fn(async () => ({ object: { decision: 'continue' }, toolCalls: [] }));

    await invokeRedactedTriageAgent(
      {
        maxModelRetries: 0,
        maxSteps: 1,
        payload: { issue: 'ISSUE_CANARY' },
        phase: 'reproduce',
        model: 'fixture-verification-model',
        schema: z.unknown(),
        timeoutMs: 1_000,
      },
      { mastra: { getAgent: () => ({ generate }) } },
    );

    expect(redactedTracingOptions).toEqual({ hideInput: true, hideOutput: true });
    expect(generate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        model: 'fixture-verification-model',
        tracingOptions: redactedTracingOptions,
      }),
    );
  });
});
