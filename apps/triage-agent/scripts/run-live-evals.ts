import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { z } from 'zod';

import { appMetadata } from '../src/config/app.js';
import type { TriageAgentModel } from '../src/mastra/agents/triage.js';
import { createTriageMastra, redactedTracingOptions } from '../src/mastra/index.js';

if (process.env.LIVE_MODEL_EXPERIMENTS !== 'true') {
  console.log('Live triage eval skipped; set LIVE_MODEL_EXPERIMENTS=true to opt in.');
  process.exitCode = 0;
} else {
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
  const responseSchema = z
    .object({
      decision: z.enum(['actionable', 'needs_reproduction', 'not_actionable']),
      reasonCode: z.string().regex(/^[A-Z0-9_]{1,100}$/u),
    })
    .strict();

  try {
    const agent = mastra.getAgent(appMetadata.agentId);
    const result = await agent.generate(
      'Classify this synthetic issue without tools: the application returns HTTP 500, but the report has no reproduction steps.',
      {
        activeTools: [],
        maxSteps: 1,
        structuredOutput: { errorStrategy: 'strict', schema: responseSchema },
        toolChoice: 'none',
        tracingOptions: redactedTracingOptions,
      },
    );
    console.log(
      JSON.stringify({
        agentId: appMetadata.agentId,
        result: responseSchema.parse(result.object),
        workflowId: appMetadata.workflowIds.triage,
      }),
    );
  } finally {
    await mastra.shutdown({ drainTimeout: 5_000 });
  }
}
