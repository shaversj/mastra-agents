import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { appMetadata } from '../../config/app.js';
import { classifyProposalResponse, proposalIdentity } from '../../domain/proposal.js';
import {
  invokeRegisteredTriageAgent,
  invokeStructuredModel,
  type ModelInvoker,
  type ModelRequest,
} from './triage.js';

const proposalSchema = z
  .object({
    baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
    branch: z.string().regex(/^triagebot\/fix-[1-9][0-9]*$/u),
    headSha: z.string().regex(/^[0-9a-f]{40}$/u),
    id: z.string().min(1),
  })
  .strict();

export const triageCommentInputSchema = z
  .object({
    actor: z
      .object({
        association: z.enum([
          'COLLABORATOR',
          'CONTRIBUTOR',
          'FIRST_TIMER',
          'FIRST_TIME_CONTRIBUTOR',
          'MANNEQUIN',
          'MEMBER',
          'NONE',
          'OWNER',
        ]),
        login: z.string().min(1).max(100),
      })
      .strict(),
    issue: z
      .object({
        body: z.string().max(65_536),
        number: z.number().int().positive(),
        reporterLogin: z.string().min(1).max(100),
        title: z.string().min(1).max(1_024),
      })
      .strict(),
    maxModelRetries: z.number().int().min(0).max(2).default(1),
    maxStageSteps: z.number().int().min(1).max(8).default(4),
    proposal: proposalSchema,
    remoteHeadSha: z.string().regex(/^[0-9a-f]{40}$/u),
    route: z.enum(['confirmation', 'retriage']),
    totalRunMs: z
      .number()
      .int()
      .min(1_000)
      .max(5 * 60_000)
      .default(4 * 60_000),
    triggeringComment: z
      .object({ body: z.string().max(65_536), id: z.number().int().positive() })
      .strict(),
  })
  .strict();

const prContentSchema = z
  .object({
    bodyFields: z.array(z.string().min(1).max(500)).min(1).max(8),
    title: z.string().min(1).max(160),
  })
  .strict();

export const triageCommentOutputSchema = z
  .object({
    action: z.enum(['create_pull_request', 'none', 'reject_proposal', 'rerun_triage']),
    commentId: z.number().int().positive(),
    prContent: prContentSchema.optional(),
    reasonCode: z.string().min(1).max(100),
    state: z.enum(['fix_pending', 'fix_rejected', 'fix_verified', 'needs_triage']),
  })
  .strict();

const retriageSchema = z
  .object({
    commentId: z.number().int().positive(),
    decision: z.enum(['ignore', 'retry']),
  })
  .strict();

const confirmationSchema = z
  .object({
    classification: z.enum(['confirmed', 'inconclusive', 'rejected']),
    commentId: z.number().int().positive(),
    mentionedProposalId: z.string().min(1).max(400).optional(),
  })
  .strict();

type CommentInput = z.infer<typeof triageCommentInputSchema>;
type CommentOutput = z.infer<typeof triageCommentOutputSchema>;

export interface TriageCommentWorkflowOptions {
  clock?: () => number;
  invokeModel?: ModelInvoker;
  prSkill?: string;
}

function safeFailure(input: CommentInput, reasonCode: string): CommentOutput {
  return {
    action: 'none',
    commentId: input.triggeringComment.id,
    reasonCode,
    state: 'fix_pending',
  };
}

async function callToolless<T extends z.ZodType>(input: {
  abortSignal?: AbortSignal;
  deadlineAt: number;
  invokeModel: ModelInvoker;
  mastra: unknown;
  payload: Readonly<Record<string, unknown>>;
  phase: ModelRequest['phase'];
  runInput: CommentInput;
  schema: T;
  skill?: string;
  now: () => number;
}): Promise<{ error?: string; value?: z.infer<T> }> {
  return invokeStructuredModel({
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    activeTools: [],
    deadlineAt: input.deadlineAt,
    invokeModel: input.invokeModel,
    mastra: input.mastra,
    maxModelRetries: input.runInput.maxModelRetries,
    maxSteps: input.runInput.maxStageSteps,
    now: input.now,
    payload: input.payload,
    phase: input.phase,
    schema: input.schema,
    ...(input.skill ? { skill: input.skill } : {}),
  });
}

export function createTriageCommentWorkflow(options: TriageCommentWorkflowOptions = {}) {
  const invokeModel = options.invokeModel ?? invokeRegisteredTriageAgent;
  const clock = options.clock ?? Date.now;

  const classifyComment = createStep({
    id: 'classify-triggering-comment',
    inputSchema: triageCommentInputSchema,
    outputSchema: triageCommentOutputSchema,
    execute: async ({ inputData, mastra, abortSignal }): Promise<CommentOutput> => {
      const deadlineAt = clock() + inputData.totalRunMs;
      if (inputData.route === 'retriage') {
        const classified = await callToolless({
          abortSignal,
          deadlineAt,
          invokeModel,
          mastra,
          now: clock,
          payload: {
            comment: inputData.triggeringComment,
            issueNumber: inputData.issue.number,
          },
          phase: 'classify_retriage',
          runInput: inputData,
          schema: retriageSchema,
        });
        if (classified.error || !classified.value) {
          return safeFailure(inputData, classified.error ?? 'MALFORMED_STRUCTURED_OUTPUT');
        }
        if (classified.value.commentId !== inputData.triggeringComment.id) {
          return safeFailure(inputData, 'COMMENT_BINDING_MISMATCH');
        }
        return classified.value.decision === 'retry'
          ? {
              action: 'rerun_triage' as const,
              commentId: inputData.triggeringComment.id,
              reasonCode: 'ACTIONABLE_RETRIAGE' as const,
              state: 'needs_triage' as const,
            }
          : safeFailure(inputData, 'NO_ACTIONABLE_INFORMATION');
      }

      const canonicalProposal = proposalIdentity(inputData.proposal);
      if (canonicalProposal.id !== inputData.proposal.id) {
        return safeFailure(inputData, 'PROPOSAL_BINDING_MISMATCH');
      }
      const eligibility = classifyProposalResponse({
        actorAssociation: inputData.actor.association,
        actorLogin: inputData.actor.login,
        classification: 'confirmed',
        issueAuthorLogin: inputData.issue.reporterLogin,
        mentionedProposalId: canonicalProposal.id,
        proposal: canonicalProposal,
        remoteHeadSha: inputData.remoteHeadSha,
      });
      if (eligibility.kind !== 'confirmed') {
        return safeFailure(inputData, eligibility.kind.toUpperCase());
      }

      const classified = await callToolless({
        abortSignal,
        deadlineAt,
        invokeModel,
        mastra,
        now: clock,
        payload: {
          comment: inputData.triggeringComment,
          proposalId: inputData.proposal.id,
        },
        phase: 'classify_confirmation',
        runInput: inputData,
        schema: confirmationSchema,
      });
      if (classified.error || !classified.value) {
        return safeFailure(inputData, classified.error ?? 'MALFORMED_STRUCTURED_OUTPUT');
      }
      if (classified.value.commentId !== inputData.triggeringComment.id) {
        return safeFailure(inputData, 'COMMENT_BINDING_MISMATCH');
      }
      const response = classifyProposalResponse({
        actorAssociation: inputData.actor.association,
        actorLogin: inputData.actor.login,
        classification: classified.value.classification,
        issueAuthorLogin: inputData.issue.reporterLogin,
        ...(classified.value.mentionedProposalId
          ? { mentionedProposalId: classified.value.mentionedProposalId }
          : {}),
        proposal: canonicalProposal,
        remoteHeadSha: inputData.remoteHeadSha,
      });
      if (response.kind === 'rejected') {
        return {
          action: 'reject_proposal',
          commentId: inputData.triggeringComment.id,
          reasonCode: 'PROPOSAL_REJECTED',
          state: 'fix_rejected',
        };
      }
      if (response.kind !== 'confirmed') {
        return safeFailure(inputData, response.kind.toUpperCase());
      }
      const prContent = await callToolless({
        abortSignal,
        deadlineAt,
        invokeModel,
        mastra,
        now: clock,
        payload: {
          issue: {
            body: inputData.issue.body,
            number: inputData.issue.number,
            title: inputData.issue.title,
          },
          proposal: {
            branch: canonicalProposal.branch,
            headSha: canonicalProposal.headSha,
            id: canonicalProposal.id,
            verificationStatus: 'verified',
          },
        },
        phase: 'draft_pr_content',
        runInput: inputData,
        schema: prContentSchema,
        ...(options.prSkill ? { skill: options.prSkill } : {}),
      });
      if (prContent.error || !prContent.value) {
        return safeFailure(inputData, prContent.error ?? 'MALFORMED_STRUCTURED_OUTPUT');
      }
      return {
        action: 'create_pull_request',
        commentId: inputData.triggeringComment.id,
        prContent: prContent.value,
        reasonCode: 'PROPOSAL_CONFIRMED',
        state: 'fix_verified',
      };
    },
  });

  return createWorkflow({
    id: appMetadata.workflowIds.comment,
    description: 'Classifies one triggering issue comment and returns a deterministic action plan.',
    inputSchema: triageCommentInputSchema,
    outputSchema: triageCommentOutputSchema,
  })
    .then(classifyComment)
    .commit();
}
