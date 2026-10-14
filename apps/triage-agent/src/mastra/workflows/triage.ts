import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { appMetadata } from '../../config/app.js';
import { selectAllowedAncillaryLabels } from '../../domain/lifecycle.js';
import type { TriageAgentModel } from '../agents/triage.js';

export type ModelPhase =
  | 'classify_confirmation'
  | 'classify_outcome'
  | 'classify_retriage'
  | 'diagnose'
  | 'draft_pr_content'
  | 'draft_report'
  | 'fix'
  | 'reproduce'
  | 'select_labels'
  | 'verify';

export interface ModelRequest {
  activeTools?: string[];
  maxModelRetries: number;
  maxSteps: number;
  model?: TriageAgentModel;
  payload: Readonly<Record<string, unknown>>;
  phase: ModelPhase;
  schema: z.ZodType;
  skill?: string;
  timeoutMs: number;
}

export interface ModelInvocation {
  object: unknown;
  toolCalls?: readonly unknown[];
}

export type ModelInvoker = (
  request: ModelRequest,
  runtime: { abortSignal?: AbortSignal; mastra: unknown },
) => Promise<ModelInvocation>;

export type ModelInvocationFailure =
  | 'MALFORMED_STRUCTURED_OUTPUT'
  | 'MODEL_RETRIES_EXHAUSTED'
  | 'MODEL_TIMEOUT'
  | 'RUN_BUDGET_EXHAUSTED'
  | 'TOOL_CALL_ATTEMPTED';

const evidenceSchema = z
  .object({
    code: z.string().min(1).max(100).optional(),
    kind: z.enum(['command', 'diff', 'file', 'model_stage', 'test']),
    phase: z.enum(['reproduce', 'diagnose', 'verify', 'fix']),
    status: z.enum(['failed', 'observed', 'passed']),
  })
  .strict();

export type WorkflowEvidence = z.infer<typeof evidenceSchema>;

export const triageWorkflowInputSchema = z
  .object({
    allowedPackageLabels: z.array(z.string().min(1).max(100)).max(100).default([]),
    allowedPriorityLabels: z.array(z.string().min(1).max(100)).max(100).default([]),
    attemptId: z.string().min(1).max(200),
    autoPrOnFix: z.boolean().default(false),
    eventFingerprint: z.string().min(1).max(500),
    generation: z.number().int().positive(),
    issue: z
      .object({
        body: z.string().max(65_536),
        number: z.number().int().positive(),
        reporterLogin: z.string().min(1).max(100),
        title: z.string().min(1).max(1_024),
      })
      .strict(),
    maxModelRetries: z.number().int().min(0).max(2).default(1),
    maxStageSteps: z.number().int().min(1).max(20).default(12),
    repository: z
      .object({
        baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
        defaultBranch: z.string().min(1).max(255),
        fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
      })
      .strict(),
    triggeringComment: z
      .object({
        body: z.string().max(65_536),
        id: z.number().int().positive(),
      })
      .strict()
      .optional(),
    totalRunMs: z
      .number()
      .int()
      .min(1_000)
      .max(15 * 60_000)
      .default(12 * 60_000),
  })
  .strict();

const reportSchema = z
  .object({
    details: z.array(z.string().min(1).max(500)).max(5),
    headline: z.string().min(1).max(160),
  })
  .strict();
const labelSelectionSchema = z
  .object({
    packageLabels: z.array(z.string().min(1).max(100)).max(3),
    priorityLabel: z.string().min(1).max(100).optional(),
  })
  .strict();
const prContentSchema = z
  .object({
    bodyFields: z.array(z.string().min(1).max(500)).min(1).max(8),
    title: z.string().min(1).max(160),
  })
  .strict();

const triageOutcomePlanSchema = z
  .object({
    kind: z.literal('triage_outcome'),
    reasonCode: z.string().min(1).max(100),
    report: reportSchema,
    state: z.enum([
      'not_actionable',
      'needs_reproduction',
      'skipped',
      'unable_to_reproduce',
      'unable_to_fix',
    ]),
  })
  .strict();
const proposalPlanSchema = z
  .object({
    kind: z.literal('publish_proposal'),
    labels: labelSelectionSchema,
    prContent: prContentSchema.optional(),
    report: reportSchema,
  })
  .strict();
const mutationPlanSchema = z.discriminatedUnion('kind', [
  triageOutcomePlanSchema,
  proposalPlanSchema,
]);
const internalMutationPlanSchema = z.discriminatedUnion('kind', [
  triageOutcomePlanSchema.extend({ report: reportSchema.optional() }),
  proposalPlanSchema,
]);

export const triageWorkflowOutputSchema = z
  .object({
    attemptId: z.string(),
    evidence: z.array(evidenceSchema),
    failureCode: z
      .enum([
        'ADMISSION_REJECTED',
        'EVIDENCE_COLLECTION_FAILED',
        'MALFORMED_STRUCTURED_OUTPUT',
        'MODEL_RETRIES_EXHAUSTED',
        'MODEL_TIMEOUT',
        'RUN_BUDGET_EXHAUSTED',
        'TOOL_CALL_ATTEMPTED',
      ])
      .optional(),
    generation: z.number().int().positive(),
    mutationPlan: mutationPlanSchema.nullable(),
    state: z.enum([
      'failed',
      'fix_pending',
      'needs_reproduction',
      'not_actionable',
      'skipped',
      'unable_to_fix',
      'unable_to_reproduce',
    ]),
    stoppedAt: z.enum(['reproduce', 'diagnose', 'verify', 'fix', 'admission']),
  })
  .strict();

const internalSchema = z
  .object({
    candidateVerifiedFix: z.boolean().optional(),
    deadlineAt: z.number(),
    evidence: z.array(evidenceSchema),
    failureCode: triageWorkflowOutputSchema.shape.failureCode,
    input: triageWorkflowInputSchema,
    mutationPlan: internalMutationPlanSchema.nullable().optional(),
    state: triageWorkflowOutputSchema.shape.state.optional(),
    stoppedAt: triageWorkflowOutputSchema.shape.stoppedAt.optional(),
  })
  .strict();

type InternalState = z.infer<typeof internalSchema>;
type TriageInput = z.infer<typeof triageWorkflowInputSchema>;

const reproduceDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('continue') }).strict(),
  z.object({ decision: z.literal('not_actionable'), reasonCode: z.literal('not_a_bug') }).strict(),
  z
    .object({ decision: z.literal('missing_reproduction'), reasonCode: z.literal('missing_steps') })
    .strict(),
  z.object({ decision: z.literal('skipped'), reasonCode: z.literal('unsupported_scope') }).strict(),
  z
    .object({
      decision: z.literal('unable_to_reproduce'),
      reasonCode: z.literal('reproduction_failed'),
    })
    .strict(),
]);
const investigationDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('continue') }).strict(),
  z
    .object({
      decision: z.literal('unable_to_fix'),
      reasonCode: z.enum(['cause_unknown', 'verification_failed']),
    })
    .strict(),
]);
const fixDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('unable_to_fix'), reasonCode: z.literal('fix_failed') }).strict(),
  z.object({ decision: z.literal('verified_fix') }).strict(),
]);
const outcomeDecisionSchema = z.discriminatedUnion('decision', [
  z
    .object({ decision: z.literal('unable_to_fix'), reasonCode: z.string().min(1).max(100) })
    .strict(),
  z.object({ decision: z.literal('verified_fix') }).strict(),
]);

export const invokeRegisteredTriageAgent: ModelInvoker = async (request, runtime) => {
  const mastra = runtime.mastra as {
    getAgent(id: string): {
      generate(
        prompt: string,
        options: Record<string, unknown>,
      ): Promise<{ object?: unknown; toolCalls?: unknown[] }>;
    };
  };
  const agent = mastra.getAgent(appMetadata.agentId);
  const result = await agent.generate(
    JSON.stringify({ phase: request.phase, ...request.payload }),
    {
      ...(request.activeTools ? { activeTools: request.activeTools } : {}),
      maxSteps: request.maxSteps,
      modelSettings: {
        maxRetries: request.maxModelRetries,
        timeout: { stepMs: request.timeoutMs, totalMs: request.timeoutMs },
      },
      ...(request.model ? { model: request.model } : {}),
      ...(request.activeTools?.length === 0 ? { toolChoice: 'none' } : {}),
      structuredOutput: { errorStrategy: 'strict', schema: request.schema },
      ...(request.skill ? { instructions: request.skill } : {}),
      ...(runtime.abortSignal ? { abortSignal: runtime.abortSignal } : {}),
      tracingOptions: redactedTracingOptions,
    },
  );
  return { object: result.object, toolCalls: result.toolCalls ?? [] };
};

export const redactedTracingOptions = {
  hideInput: true,
  hideOutput: true,
} as const;

export interface TriageWorkflowOptions {
  admitChanges?: (input: { evidence: WorkflowEvidence[]; input: TriageInput }) => Promise<boolean>;
  clock?: () => number;
  collectEvidence?: (input: {
    input: TriageInput;
    phase: 'reproduce' | 'diagnose' | 'verify' | 'fix';
  }) => Promise<WorkflowEvidence[]>;
  invokeModel?: ModelInvoker;
  prSkill?: string;
}

function failed(
  state: InternalState,
  code: NonNullable<InternalState['failureCode']>,
): InternalState {
  if (state.state) return state;
  return {
    ...state,
    failureCode: code,
    mutationPlan: null,
    state: 'failed',
    stoppedAt: 'admission',
  };
}

function toWorkflowOutput(state: InternalState): z.infer<typeof triageWorkflowOutputSchema> {
  if (!state.state) throw new Error('TRIAGE_WORKFLOW_STATE_MISSING');
  return triageWorkflowOutputSchema.parse({
    attemptId: state.input.attemptId,
    evidence: state.evidence,
    ...(state.failureCode ? { failureCode: state.failureCode } : {}),
    generation: state.input.generation,
    mutationPlan: state.mutationPlan ?? null,
    state: state.state,
    stoppedAt: state.stoppedAt ?? 'admission',
  });
}

function invocationFailure(error: unknown): 'MODEL_RETRIES_EXHAUSTED' | 'MODEL_TIMEOUT' {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /timeout|timed out|aborted/iu.test(text) ? 'MODEL_TIMEOUT' : 'MODEL_RETRIES_EXHAUSTED';
}

export async function invokeStructuredModel<T extends z.ZodType>(input: {
  abortSignal?: AbortSignal;
  activeTools?: string[];
  deadlineAt: number;
  invokeModel: ModelInvoker;
  mastra: unknown;
  maxModelRetries: number;
  maxSteps: number;
  now: () => number;
  payload: Readonly<Record<string, unknown>>;
  phase: ModelPhase;
  schema: T;
  skill?: string;
}): Promise<{ error?: ModelInvocationFailure; value?: z.infer<T> }> {
  const timeoutMs = Math.max(0, input.deadlineAt - input.now());
  if (timeoutMs === 0) return { error: 'RUN_BUDGET_EXHAUSTED' };
  let result: ModelInvocation;
  try {
    result = await input.invokeModel(
      {
        ...(input.activeTools ? { activeTools: input.activeTools } : {}),
        maxModelRetries: input.maxModelRetries,
        maxSteps: input.maxSteps,
        payload: input.payload,
        phase: input.phase,
        schema: input.schema,
        ...(input.skill ? { skill: input.skill } : {}),
        timeoutMs,
      },
      { ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}), mastra: input.mastra },
    );
  } catch (error) {
    return { error: invocationFailure(error) };
  }
  if (input.activeTools?.length === 0 && (result.toolCalls?.length ?? 0) > 0) {
    return { error: 'TOOL_CALL_ATTEMPTED' };
  }
  const parsed = input.schema.safeParse(result.object);
  return parsed.success ? { value: parsed.data } : { error: 'MALFORMED_STRUCTURED_OUTPUT' };
}

async function invokeParsed<T extends z.ZodType>(input: {
  activeTools?: string[];
  clock: () => number;
  invokeModel: ModelInvoker;
  phase: ModelPhase;
  runtime: { abortSignal?: AbortSignal; mastra: unknown };
  schema: T;
  skill?: string;
  state: InternalState;
}): Promise<{ error?: NonNullable<InternalState['failureCode']>; value?: z.infer<T> }> {
  return invokeStructuredModel({
    ...(input.runtime.abortSignal ? { abortSignal: input.runtime.abortSignal } : {}),
    ...(input.activeTools ? { activeTools: input.activeTools } : {}),
    deadlineAt: input.state.deadlineAt,
    invokeModel: input.invokeModel,
    mastra: input.runtime.mastra,
    maxModelRetries: input.state.input.maxModelRetries,
    maxSteps: input.state.input.maxStageSteps,
    now: input.clock,
    payload: {
      attemptId: input.state.input.attemptId,
      evidence: input.state.evidence,
      issue: input.state.input.issue,
      repository: input.state.input.repository,
      ...(input.state.input.triggeringComment
        ? { triggeringComment: input.state.input.triggeringComment }
        : {}),
    },
    phase: input.phase,
    schema: input.schema,
    ...(input.skill ? { skill: input.skill } : {}),
  });
}

function closeEarly(
  state: InternalState,
  phase: 'reproduce' | 'diagnose' | 'verify' | 'fix',
  decision: { decision: string; reasonCode?: string },
): InternalState {
  const mapped = {
    missing_reproduction: 'needs_reproduction',
    not_actionable: 'not_actionable',
    skipped: 'skipped',
    unable_to_fix: 'unable_to_fix',
    unable_to_reproduce: 'unable_to_reproduce',
  } as const;
  const stateName = mapped[decision.decision as keyof typeof mapped];
  if (!stateName) return state;
  const reasonCode = decision.reasonCode ?? decision.decision;
  return {
    ...state,
    mutationPlan: { kind: 'triage_outcome', reasonCode, state: stateName },
    state: stateName,
    stoppedAt: phase,
  };
}

export function createTriageWorkflow(options: TriageWorkflowOptions = {}) {
  const clock = options.clock ?? Date.now;
  const invokeModel = options.invokeModel ?? invokeRegisteredTriageAgent;
  const collectEvidence = options.collectEvidence ?? (async () => []);

  const prepareContext = createStep({
    id: 'prepare-triage-context',
    inputSchema: triageWorkflowInputSchema,
    outputSchema: internalSchema,
    execute: async ({ inputData }) => ({
      deadlineAt: clock() + inputData.totalRunMs,
      evidence: [],
      input: inputData,
    }),
  });

  function stage(
    phase: 'reproduce' | 'diagnose' | 'verify' | 'fix',
    schema:
      | typeof reproduceDecisionSchema
      | typeof investigationDecisionSchema
      | typeof fixDecisionSchema,
  ) {
    return createStep({
      id: `${phase}-issue`,
      inputSchema: internalSchema,
      outputSchema: internalSchema,
      execute: async ({ inputData, mastra, abortSignal }) => {
        if (inputData.state) return inputData;
        const invocation = await invokeParsed({
          clock,
          invokeModel,
          phase,
          runtime: { abortSignal, mastra },
          schema,
          state: inputData,
        });
        if (invocation.error) return failed(inputData, invocation.error);
        let evidence: WorkflowEvidence[];
        try {
          evidence = await collectEvidence({ input: inputData.input, phase });
        } catch {
          return failed(inputData, 'EVIDENCE_COLLECTION_FAILED');
        }
        const next = { ...inputData, evidence: [...inputData.evidence, ...evidence] };
        const decision = invocation.value as {
          decision: string;
          reasonCode?: string;
        };
        if (decision.decision === 'verified_fix') {
          return { ...next, candidateVerifiedFix: true };
        }
        return closeEarly(next, phase, decision);
      },
    });
  }

  const classifyOutcome = createStep({
    id: 'classify-triage-outcome',
    inputSchema: internalSchema,
    outputSchema: internalSchema,
    execute: async ({ inputData, mastra, abortSignal }) => {
      if (inputData.state) return inputData;
      if (!inputData.candidateVerifiedFix || inputData.evidence.length === 0) {
        return failed(inputData, 'ADMISSION_REJECTED');
      }
      const invocation = await invokeParsed({
        activeTools: [],
        clock,
        invokeModel,
        phase: 'classify_outcome',
        runtime: { abortSignal, mastra },
        schema: outcomeDecisionSchema,
        state: inputData,
      });
      if (invocation.error) return failed(inputData, invocation.error);
      if (!invocation.value) return failed(inputData, 'MALFORMED_STRUCTURED_OUTPUT');
      const decision = invocation.value;
      if (decision.decision !== 'verified_fix') {
        return closeEarly(inputData, 'fix', decision);
      }
      return inputData;
    },
  });

  const draftOutcomeReport = createStep({
    id: 'draft-triage-outcome-report',
    inputSchema: internalSchema,
    outputSchema: internalSchema,
    execute: async ({ inputData, mastra, abortSignal }) => {
      if (inputData.mutationPlan?.kind !== 'triage_outcome') return inputData;
      const report = await invokeParsed({
        activeTools: [],
        clock,
        invokeModel,
        phase: 'draft_report',
        runtime: { abortSignal, mastra },
        schema: reportSchema,
        state: inputData,
      });
      if (report.error || !report.value) {
        return {
          ...inputData,
          failureCode: report.error ?? 'MALFORMED_STRUCTURED_OUTPUT',
          mutationPlan: null,
          state: 'failed' as const,
          stoppedAt: 'admission' as const,
        };
      }
      return {
        ...inputData,
        mutationPlan: { ...inputData.mutationPlan, report: report.value },
      };
    },
  });

  const admitProposal = createStep({
    id: 'admit-triage-proposal',
    inputSchema: internalSchema,
    outputSchema: triageWorkflowOutputSchema,
    execute: async ({ inputData, mastra, abortSignal }) => {
      if (inputData.state) return toWorkflowOutput(inputData);
      if (!inputData.candidateVerifiedFix) {
        return toWorkflowOutput(failed(inputData, 'ADMISSION_REJECTED'));
      }
      if (
        !inputData.evidence.some(
          ({ kind, phase, status }) =>
            phase === 'verify' && status === 'passed' && (kind === 'command' || kind === 'test'),
        )
      ) {
        return toWorkflowOutput(failed(inputData, 'ADMISSION_REJECTED'));
      }
      const admitted =
        (await options.admitChanges?.({
          evidence: inputData.evidence,
          input: inputData.input,
        })) ?? false;
      if (!admitted) {
        return toWorkflowOutput(failed(inputData, 'ADMISSION_REJECTED'));
      }

      const report = await invokeParsed({
        activeTools: [],
        clock,
        invokeModel,
        phase: 'draft_report',
        runtime: { abortSignal, mastra },
        schema: reportSchema,
        state: inputData,
      });
      if (report.error || !report.value) {
        return toWorkflowOutput(failed(inputData, report.error ?? 'MALFORMED_STRUCTURED_OUTPUT'));
      }
      const labels = await invokeParsed({
        activeTools: [],
        clock,
        invokeModel,
        phase: 'select_labels',
        runtime: { abortSignal, mastra },
        schema: labelSelectionSchema,
        state: inputData,
      });
      if (labels.error || !labels.value) {
        return toWorkflowOutput(failed(inputData, labels.error ?? 'MALFORMED_STRUCTURED_OUTPUT'));
      }
      const selectedLabels = selectAllowedAncillaryLabels({
        allowedPackageLabels: inputData.input.allowedPackageLabels,
        allowedPriorityLabels: inputData.input.allowedPriorityLabels,
        requestedPackageLabels: labels.value.packageLabels,
        ...(labels.value.priorityLabel
          ? { requestedPriorityLabel: labels.value.priorityLabel }
          : {}),
      });
      const prContent = inputData.input.autoPrOnFix
        ? await invokeParsed({
            activeTools: [],
            clock,
            invokeModel,
            phase: 'draft_pr_content',
            runtime: { abortSignal, mastra },
            schema: prContentSchema,
            ...(options.prSkill ? { skill: options.prSkill } : {}),
            state: inputData,
          })
        : undefined;
      if (prContent?.error || (inputData.input.autoPrOnFix && !prContent?.value)) {
        return toWorkflowOutput(
          failed(inputData, prContent?.error ?? 'MALFORMED_STRUCTURED_OUTPUT'),
        );
      }
      const plan = {
        kind: 'publish_proposal' as const,
        labels: selectedLabels,
        ...(prContent?.value ? { prContent: prContent.value } : {}),
        report: report.value,
      };
      return {
        attemptId: inputData.input.attemptId,
        evidence: inputData.evidence,
        generation: inputData.input.generation,
        mutationPlan: plan,
        state: 'fix_pending' as const,
        stoppedAt: 'admission' as const,
      };
    },
  });

  return createWorkflow({
    id: appMetadata.workflowIds.triage,
    description: 'Runs bounded staged issue triage and returns a deterministic mutation plan.',
    inputSchema: triageWorkflowInputSchema,
    outputSchema: triageWorkflowOutputSchema,
  })
    .then(prepareContext)
    .then(stage('reproduce', reproduceDecisionSchema))
    .then(stage('diagnose', investigationDecisionSchema))
    .then(stage('fix', fixDecisionSchema))
    .then(stage('verify', investigationDecisionSchema))
    .then(draftOutcomeReport)
    .then(classifyOutcome)
    .then(admitProposal)
    .commit();
}
