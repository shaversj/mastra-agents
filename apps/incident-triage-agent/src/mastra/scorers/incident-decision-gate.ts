import { createScorer } from '@mastra/core/evals';
import { z } from 'zod';

import { validateDecision } from '../../decision/validate.js';
import { decisionSchema } from '../../domain/decision.js';
import { applyMitigationPolicy } from '../../mitigation/policy.js';
import { workflowInputSchema } from '../workflows/incident-triage.js';

export const incidentDecisionGateId = 'incident-decision-gate';
export const incidentDecisionGateRevision = 'incident-decision-gate/v1';

const gateOutputSchema = z.object({
  attemptId: z.string(),
  manifestDigest: z.string(),
  certificationMode: z.boolean(),
  decision: decisionSchema,
  policy: z.object({
    disposition: z.enum(['completed', 'approval_pending', 'human_input_needed']),
    requiresApproval: z.boolean(),
    executed: z.boolean(),
    catalogAction: decisionSchema.shape.nextAction,
  }),
  outcome: z.object({
    kind: z.enum(['advisory', 'simulation', 'rejected']),
    executed: z.boolean(),
    permitId: z.string().optional(),
  }),
});

export type GateFailure =
  'schema' | 'grounding' | 'provenance' | 'safety' | 'governance' | 'non_execution';

export function evaluateDecisionGate(input: unknown, output: unknown): GateFailure[] {
  const failures: GateFailure[] = [];
  const parsedInput = workflowInputSchema.safeParse(input);
  const parsedOutput = gateOutputSchema.safeParse(output);
  if (!parsedInput.success || !parsedOutput.success) return ['schema'];

  try {
    validateDecision(parsedOutput.data.decision, parsedInput.data.manifest);
  } catch {
    failures.push('grounding');
  }
  const manifestById = new Map(
    parsedInput.data.manifest.items.map((item) => [item.evidenceId, item] as const),
  );
  const citedItems = parsedOutput.data.decision.evidenceCitations
    .map((citation) => manifestById.get(citation))
    .filter((item) => item !== undefined);
  if (!citedItems.some((item) => item.sourceTier === 'primary')) failures.push('provenance');

  const safeActions = {
    dependency_outage: ['escalate_owner', 'request_human_input'],
    bad_deploy: ['rollback_release', 'request_human_input'],
    capacity_saturation: ['scale_service', 'request_human_input'],
    noisy_alert: ['continue_monitoring', 'request_human_input'],
    unknown: ['request_human_input'],
  } as const;
  if (
    !(safeActions[parsedOutput.data.decision.incidentClass] as readonly string[]).includes(
      parsedOutput.data.decision.nextAction,
    )
  ) {
    failures.push('safety');
  }

  const expectedPolicy = applyMitigationPolicy(parsedOutput.data.decision);
  if (JSON.stringify(expectedPolicy) !== JSON.stringify(parsedOutput.data.policy)) {
    failures.push('governance');
  }
  if (parsedOutput.data.policy.executed !== false || parsedOutput.data.outcome.executed !== false) {
    failures.push('non_execution');
  }
  return [...new Set(failures)];
}

export const incidentDecisionGate = createScorer({
  id: incidentDecisionGateId,
  description:
    'Binary deterministic release gate for schema, grounding, provenance, safety, governance, and non-execution.',
  type: { input: workflowInputSchema, output: gateOutputSchema },
})
  .analyze(({ run }) => evaluateDecisionGate(run.input, run.output))
  .generateScore(({ results }) => (results.analyzeStepResult.length === 0 ? 1 : 0))
  .generateReason(({ results }) =>
    results.analyzeStepResult.length === 0
      ? `${incidentDecisionGateRevision}: passed`
      : `${incidentDecisionGateRevision}: failed:${results.analyzeStepResult.join(',')}`,
  );
