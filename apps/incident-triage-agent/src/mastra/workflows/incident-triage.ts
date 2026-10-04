import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { appMetadata } from '../../config/app.js';
import { validateDecision } from '../../decision/validate.js';
import { decisionSchema, nextActions } from '../../domain/decision.js';
import { applyMitigationPolicy } from '../../mitigation/policy.js';

const manifestItemSchema = z.object({
  evidenceId: z.string().min(1),
  source: z.string().min(1),
  sourceTier: z.enum(['primary', 'secondary', 'context']),
  sourceLocator: z.string().min(1),
  freshness: z.enum(['fresh', 'stale', 'unknown']),
  collectionStatus: z.enum(['complete', 'partial']),
});

export const workflowInputSchema = z.object({
  attemptId: z.string().min(1),
  incident: z.record(z.string(), z.unknown()),
  manifest: z.object({
    id: z.string().min(1),
    attemptId: z.string().min(1),
    digest: z.string().min(1),
    items: z.array(manifestItemSchema).min(1),
    sealedAt: z.string().datetime(),
  }),
});

const workflowOutputSchema = z.object({
  attemptId: z.string(),
  decision: decisionSchema,
  policy: z.object({
    disposition: z.enum(['completed', 'approval_pending', 'human_input_needed']),
    requiresApproval: z.boolean(),
    executed: z.literal(false),
    catalogAction: z.enum(nextActions),
  }),
});

const requestJudgment = createStep({
  id: 'request-structured-judgment',
  inputSchema: workflowInputSchema,
  outputSchema: z.object({ input: workflowInputSchema, candidate: z.unknown() }),
  execute: async ({ inputData, mastra, abortSignal }) => {
    const agent = mastra.getAgent(appMetadata.agentId);
    const result = await agent.generate(
      `Assess this normalized incident using only the sealed evidence manifest.\n${JSON.stringify({
        incident: inputData.incident,
        manifest: inputData.manifest,
      })}`,
      { structuredOutput: { schema: decisionSchema }, abortSignal },
    );
    return { input: inputData, candidate: result.object };
  },
});

const validateAndApplyPolicy = createStep({
  id: 'validate-and-apply-policy',
  inputSchema: z.object({ input: workflowInputSchema, candidate: z.unknown() }),
  outputSchema: workflowOutputSchema,
  execute: async ({ inputData }) => {
    const decision = validateDecision(inputData.candidate, inputData.input.manifest);
    return {
      attemptId: inputData.input.attemptId,
      decision,
      policy: applyMitigationPolicy(decision),
    };
  },
});

export function createIncidentTriageWorkflow() {
  return createWorkflow({
    id: appMetadata.workflowId,
    description:
      'Runs one bounded judgment over a sealed incident evidence manifest and applies simulation-only mitigation policy.',
    inputSchema: workflowInputSchema,
    outputSchema: workflowOutputSchema,
  })
    .then(requestJudgment)
    .then(validateAndApplyPolicy)
    .commit();
}

export const incidentTriageWorkflow = createIncidentTriageWorkflow();
