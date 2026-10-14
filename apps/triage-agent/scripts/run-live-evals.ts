import { pathToFileURL } from 'node:url';

import { LocalFilesystem, Workspace } from '@mastra/core/workspace';

import { appMetadata } from '../src/config/app.js';
import type { TriageAgentModel } from '../src/mastra/agents/triage.js';
import { createTriageMastra, redactedTracingOptions } from '../src/mastra/index.js';
import {
  triageReleaseGateInputSchema,
  triageReleaseGateOutputSchema,
} from '../src/mastra/scorers/triage-release-gate.js';

const liveEvalInput = triageReleaseGateInputSchema.parse({
  event: {
    action: 'opened',
    actorAssociation: 'NONE',
    actorLogin: 'reporter',
    eventFingerprint: 'live-eval-open',
    issueAuthorLogin: 'reporter',
    trustedActivation: false,
    trustedReset: false,
  },
  policy: {
    activationPolicy: 'automatic-public',
    allowDownstreamWorkflows: false,
    publicationTokenKind: 'github-token',
    safeDownstreamCi: false,
  },
  prior: { generation: 0, state: 'needs_triage' },
  repository: {
    baseSha: 'a'.repeat(40),
    defaultBranch: 'main',
    fullName: 'owner/repo',
    issueNumber: 42,
    visibility: 'public',
  },
});

interface LiveEvalRegistry {
  getAgent(id: string): {
    generate(
      prompt: string,
      options: Record<string, unknown>,
    ): Promise<{ object?: unknown; toolCalls?: unknown[] }>;
  };
  listScorers():
    | Record<
        string,
        {
          run(input: { input: unknown; output: unknown }): Promise<{
            analyzeStepResult?: unknown;
            reason?: unknown;
            score?: unknown;
          }>;
        }
      >
    | undefined;
}

export async function runRegisteredLiveEval(mastra: LiveEvalRegistry) {
  const agent = mastra.getAgent(appMetadata.agentId);
  const scorer = mastra.listScorers()?.[appMetadata.scorerId];
  if (!scorer) throw new Error('TRIAGE_RELEASE_GATE_NOT_REGISTERED');

  const result = await agent.generate(
    JSON.stringify({
      instruction:
        'Return a schema-valid observation of this synthetic run. No mutation occurred, the model was invoked, and the issue remains in needs_triage.',
      input: liveEvalInput,
    }),
    {
      activeTools: [],
      maxSteps: 1,
      structuredOutput: {
        errorStrategy: 'strict',
        schema: triageReleaseGateOutputSchema,
      },
      toolChoice: 'none',
      tracingOptions: redactedTracingOptions,
    },
  );
  if ((result.toolCalls?.length ?? 0) > 0) throw new Error('LIVE_EVAL_TOOL_CALL_ATTEMPTED');

  const output = triageReleaseGateOutputSchema.parse(result.object);
  const gate = await scorer.run({ input: liveEvalInput, output });
  if (gate.score !== 1) {
    throw new Error(`LIVE_EVAL_RELEASE_GATE_FAILED:${JSON.stringify(gate.analyzeStepResult)}`);
  }

  return {
    agentId: appMetadata.agentId,
    gate: { reason: gate.reason, score: gate.score },
    result: output,
    scorerId: appMetadata.scorerId,
  };
}

async function main() {
  if (process.env.LIVE_MODEL_EXPERIMENTS !== 'true') {
    console.log('Live triage eval skipped; set LIVE_MODEL_EXPERIMENTS=true to opt in.');
    return;
  }

  const model = process.env.MODEL_ID;
  if (!model) throw new Error('MODEL_ID is required for a live triage eval');

  const mastra = createTriageMastra({
    history: {
      blame: async () => {
        throw new Error('LIVE_EVAL_HISTORY_DISABLED');
      },
      log: async () => {
        throw new Error('LIVE_EVAL_HISTORY_DISABLED');
      },
    },
    model: model as TriageAgentModel,
    workspace: new Workspace({
      filesystem: new LocalFilesystem({
        basePath: process.cwd(),
        contained: true,
        readOnly: true,
      }),
      id: 'triage-live-eval-workspace',
      tools: { enabled: false },
    }),
  });

  try {
    console.log(JSON.stringify(await runRegisteredLiveEval(mastra)));
  } finally {
    await mastra.shutdown({ drainTimeout: 5_000 });
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) await main();
