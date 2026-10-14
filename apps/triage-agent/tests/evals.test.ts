import { readFile } from 'node:fs/promises';

import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { describe, expect, it, vi } from 'vitest';

import { appMetadata } from '../src/config/app.js';
import type { TriageAgentModel } from '../src/mastra/agents/triage.js';
import { createTriageMastra } from '../src/mastra/index.js';

interface ParityCase {
  expectedFailures: string[];
  input: unknown;
  name: string;
  output: unknown;
}

const cases = JSON.parse(
  await readFile(new URL('./fixtures/evals/triage-parity.json', import.meta.url), 'utf8'),
) as ParityCase[];

function fixtureMastra(invokeModel = vi.fn()) {
  return createTriageMastra({
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

describe('model-free triage parity evals', () => {
  it('resolves the workflow and scorer from the Mastra registry and scores every approved case 1.0', async () => {
    const mastra = fixtureMastra();
    expect(mastra.getWorkflow(appMetadata.workflowIds.triage)).toBeDefined();
    const scorer = mastra.listScorers()?.[appMetadata.scorerId];
    if (!scorer) throw new Error('TRIAGE_RELEASE_GATE_NOT_REGISTERED');

    for (const fixture of cases) {
      const result = await scorer.run({ input: fixture.input, output: fixture.output });
      expect(result.analyzeStepResult, fixture.name).toEqual({
        failures: fixture.expectedFailures,
      });
      expect(result.score, fixture.name).toBe(1);
    }
  });

  it('never calls a provider during the default eval even when provider variables exist', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'provider-canary');
    vi.stubEnv('OPENAI_API_KEY', 'provider-canary');
    const invokeModel = vi.fn();
    const mastra = fixtureMastra(invokeModel);
    const scorer = mastra.listScorers()?.[appMetadata.scorerId];
    if (!scorer) throw new Error('TRIAGE_RELEASE_GATE_NOT_REGISTERED');

    const fixture = cases[0];
    if (!fixture) throw new Error('TRIAGE_PARITY_FIXTURE_MISSING');
    await scorer.run({ input: fixture.input, output: fixture.output });

    expect(invokeModel).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
