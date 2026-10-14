import { readFile } from 'node:fs/promises';

import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { describe, expect, it, vi } from 'vitest';

import { appMetadata } from '../src/config/app.js';
import type { TriageAgentModel } from '../src/mastra/agents/triage.js';
import { createTriageMastra } from '../src/mastra/index.js';
import {
  triageReleaseGateInputSchema,
  triageReleaseGateOutputSchema,
} from '../src/mastra/scorers/triage-release-gate.js';
import type { ModelRequest } from '../src/mastra/workflows/triage.js';
import { runRegisteredLiveEval } from '../scripts/run-live-evals.js';

interface ParityCase {
  expectedFailures: string[];
  input: unknown;
  name: string;
  output: unknown;
}

const cases = JSON.parse(
  await readFile(new URL('./fixtures/evals/triage-parity.json', import.meta.url), 'utf8'),
) as ParityCase[];

function fixtureMastra(
  invokeModel: (
    request: ModelRequest,
  ) => Promise<{ object: unknown; toolCalls: unknown[] }> = vi.fn(),
) {
  return createTriageMastra({
    admitChanges: async () => true,
    collectEvidence: async ({ phase }) => [
      phase === 'verify'
        ? { kind: 'test', phase, status: 'passed' as const }
        : { kind: 'model_stage', phase, status: 'observed' as const },
    ],
    history: { blame: vi.fn(), log: vi.fn() },
    invokeModel,
    model: createMockModel({ mockText: 'fixture', version: 'v2' }) as TriageAgentModel,
    workspace: new Workspace({
      filesystem: new LocalFilesystem({
        basePath: process.cwd(),
        contained: true,
        readOnly: true,
      }),
      id: 'eval-fixture-workspace',
    }),
  });
}

function parityModel(expectedState: string) {
  return vi.fn(async (request: ModelRequest) => {
    const object =
      expectedState === 'not_actionable' && request.phase === 'reproduce'
        ? { decision: 'not_actionable', reasonCode: 'not_a_bug' }
        : request.phase === 'fix' || request.phase === 'classify_outcome'
          ? { decision: 'verified_fix' }
          : request.phase === 'draft_report'
            ? { details: ['Deterministic parity fixture.'], headline: 'Parity outcome' }
            : request.phase === 'select_labels'
              ? { packageLabels: [] }
              : { decision: 'continue' };
    return { object, toolCalls: [] };
  });
}

async function runRegisteredParityWorkflow(fixture: ParityCase) {
  const gateInput = triageReleaseGateInputSchema.parse(fixture.input);
  const gateOutput = triageReleaseGateOutputSchema.parse(fixture.output);
  const invokeModel = parityModel(gateOutput.state);
  const mastra = fixtureMastra(invokeModel);
  const workflow = mastra.getWorkflow(appMetadata.workflowIds.triage);
  const run = await workflow.createRun();
  const result = await run.start({
    inputData: {
      allowedPackageLabels: [],
      allowedPriorityLabels: [],
      attemptId: `parity-${gateInput.event.eventFingerprint}`,
      autoPrOnFix: false,
      eventFingerprint: gateInput.event.eventFingerprint,
      generation: gateOutput.generation,
      issue: {
        body: 'Deterministic model-free parity case.',
        number: gateInput.repository.issueNumber,
        reporterLogin: gateInput.event.issueAuthorLogin,
        title: fixture.name,
      },
      repository: {
        baseSha: gateInput.repository.baseSha,
        defaultBranch: gateInput.repository.defaultBranch,
        fullName: gateInput.repository.fullName,
      },
    },
  });
  expect(result.status, fixture.name).toBe('success');
  if (result.status !== 'success') throw new Error(`TRIAGE_PARITY_WORKFLOW_FAILED:${fixture.name}`);
  expect(result.result.state, fixture.name).toBe(gateOutput.state);
  return {
    gateInput,
    gateOutput: { ...gateOutput, state: result.result.state },
    invokeModel,
    mastra,
  };
}

describe('model-free triage parity evals', () => {
  it('executes the registered workflow for model-invoked cases and gates every approved outcome', async () => {
    for (const fixture of cases) {
      const gateOutput = triageReleaseGateOutputSchema.parse(fixture.output);
      const evaluation = gateOutput.modelInvoked
        ? await runRegisteredParityWorkflow(fixture)
        : {
            gateInput: triageReleaseGateInputSchema.parse(fixture.input),
            gateOutput,
            mastra: fixtureMastra(),
          };
      const scorer = evaluation.mastra.listScorers()?.[appMetadata.scorerId];
      if (!scorer) throw new Error('TRIAGE_RELEASE_GATE_NOT_REGISTERED');
      const result = await scorer.run({
        input: evaluation.gateInput,
        output: evaluation.gateOutput,
      });
      expect(result.analyzeStepResult, fixture.name).toEqual({
        failures: fixture.expectedFailures,
      });
      expect(result.score, fixture.name).toBe(1);
    }
  });

  it('uses only the injected deterministic model during default evals', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'provider-canary');
    vi.stubEnv('OPENAI_API_KEY', 'provider-canary');

    const fixture = cases[0];
    if (!fixture) throw new Error('TRIAGE_PARITY_FIXTURE_MISSING');
    const { invokeModel } = await runRegisteredParityWorkflow(fixture);

    expect(invokeModel).toHaveBeenCalled();
    expect(invokeModel.mock.calls.every(([request]) => request.model === undefined)).toBe(true);
    vi.unstubAllEnvs();
  });

  it('fails a live result unless the registered deterministic scorer returns one', async () => {
    const validOutput = triageReleaseGateOutputSchema.parse({
      actor: { association: 'NONE', login: 'reporter' },
      defaultBranchWritten: false,
      eventFingerprint: 'live-eval-open',
      evidence: [],
      generation: 1,
      merged: false,
      modelInvoked: true,
      mutations: [],
      publicationTriggersDownstreamWorkflows: false,
      route: 'noop',
      state: 'needs_triage',
    });
    const generate = vi.fn(async () => ({ object: validOutput, toolCalls: [] }));
    const run = vi.fn(async () => ({
      analyzeStepResult: { failures: ['schema'] },
      reason: 'triage-release-gate/v1: failed:schema',
      score: 0,
    }));

    await expect(
      runRegisteredLiveEval({
        getAgent: () => ({ generate }),
        listScorers: () => ({ [appMetadata.scorerId]: { run } }),
      }),
    ).rejects.toThrow('LIVE_EVAL_RELEASE_GATE_FAILED');
    expect(generate).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });
});
