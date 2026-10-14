import { createScorer } from '@mastra/core/evals';
import { z } from 'zod';

import { lifecycleStates, transitionLifecycle } from '../../domain/lifecycle.js';

export const triageReleaseGateId = 'triage-release-gate';
export const triageReleaseGateRevision = 'triage-release-gate/v1';

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const associationSchema = z.enum([
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIMER',
  'MEMBER',
  'NONE',
  'OWNER',
]);
const stateSchema = z.enum(lifecycleStates);

export const triageReleaseGateInputSchema = z
  .object({
    event: z
      .object({
        action: z.enum(['comment', 'opened', 'reopened']),
        actorAssociation: associationSchema,
        actorLogin: z.string().min(1).max(100),
        eventFingerprint: z.string().min(1).max(500),
        issueAuthorLogin: z.string().min(1).max(100),
        trustedActivation: z.boolean(),
        trustedReset: z.boolean(),
      })
      .strict(),
    policy: z
      .object({
        activationPolicy: z.enum(['automatic-public', 'trusted']),
        allowDownstreamWorkflows: z.boolean(),
        publicationTokenKind: z.enum(['github-token', 'workflow-triggering']),
        safeDownstreamCi: z.boolean(),
      })
      .strict(),
    prior: z
      .object({
        generation: z.number().int().nonnegative(),
        state: stateSchema,
      })
      .strict(),
    repository: z
      .object({
        baseSha: shaSchema,
        defaultBranch: z.string().min(1).max(255),
        fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
        issueNumber: z.number().int().positive(),
        observedProposalHeadSha: shaSchema.optional(),
        visibility: z.enum(['internal', 'private', 'public']),
      })
      .strict(),
  })
  .strict();

export const triageReleaseGateOutputSchema = z
  .object({
    actor: z
      .object({
        association: associationSchema,
        login: z.string().min(1).max(100),
      })
      .strict(),
    defaultBranchWritten: z.boolean(),
    eventFingerprint: z.string().min(1).max(500),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(['command', 'diff', 'file', 'model_stage', 'test']),
            source: z.enum(['model', 'trusted-sandbox']),
            status: z.enum(['failed', 'observed', 'passed']),
          })
          .strict(),
      )
      .max(100),
    generation: z.number().int().positive(),
    merged: z.boolean(),
    modelInvoked: z.boolean(),
    mutations: z
      .array(
        z
          .object({
            idempotencyKey: z.string().min(1).max(300),
            kind: z.enum([
              'branch_push',
              'cleanup',
              'comment',
              'default_branch_write',
              'labels',
              'merge',
              'pull_request',
            ]),
            ref: z.string().min(1).max(255).optional(),
            sha: shaSchema.optional(),
          })
          .strict(),
      )
      .max(30),
    proposal: z
      .object({
        baseSha: shaSchema,
        branch: z.string().min(1).max(255),
        headSha: shaSchema,
      })
      .strict()
      .optional(),
    publicationTriggersDownstreamWorkflows: z.boolean(),
    route: z.enum(['cleanup', 'confirmation', 'noop', 'recover', 'retriage', 'triage']),
    state: stateSchema,
  })
  .strict();

export type TriageReleaseGateFailure =
  | 'activation'
  | 'actor_sha_binding'
  | 'branch_scope'
  | 'evidence_provenance'
  | 'generation'
  | 'idempotency'
  | 'no_merge_or_default_write'
  | 'publication_policy'
  | 'schema'
  | 'transition'
  | 'visibility';

const trustedAssociations = new Set(['COLLABORATOR', 'MEMBER', 'OWNER']);

export function evaluateTriageReleaseGate(
  rawInput: unknown,
  rawOutput: unknown,
): TriageReleaseGateFailure[] {
  const parsedInput = triageReleaseGateInputSchema.safeParse(rawInput);
  const parsedOutput = triageReleaseGateOutputSchema.safeParse(rawOutput);
  if (!parsedInput.success || !parsedOutput.success) return ['schema'];

  const input = parsedInput.data;
  const output = parsedOutput.data;
  const failures: TriageReleaseGateFailure[] = [];
  const hasExternalEffects = output.modelInvoked || output.mutations.length > 0;

  if (input.repository.visibility !== 'public' && hasExternalEffects) failures.push('visibility');

  if (
    input.policy.activationPolicy === 'trusted' &&
    !input.event.trustedActivation &&
    !input.event.trustedReset &&
    hasExternalEffects
  ) {
    failures.push('activation');
  }

  const expectedGeneration =
    input.event.action === 'opened' || input.event.action === 'reopened' || input.event.trustedReset
      ? input.prior.generation + 1
      : input.prior.generation;
  if (output.generation !== expectedGeneration) failures.push('generation');

  if (
    output.state !== input.prior.state &&
    transitionLifecycle(input.prior.state, output.state).kind !== 'transition'
  ) {
    failures.push('transition');
  }

  const trustedEvidence = output.evidence.every(
    ({ kind, source }) =>
      source === 'trusted-sandbox' || (kind !== 'command' && kind !== 'diff' && kind !== 'test'),
  );
  const fixEvidencePresent =
    output.state !== 'fix_pending' && output.state !== 'fix_verified'
      ? true
      : output.evidence.some(
          ({ kind, source, status }) =>
            kind === 'diff' && source === 'trusted-sandbox' && status === 'observed',
        ) &&
        output.evidence.some(
          ({ kind, source, status }) =>
            kind === 'test' && source === 'trusted-sandbox' && status === 'passed',
        );
  if (!trustedEvidence || !fixEvidencePresent) failures.push('evidence_provenance');

  const proposalBound =
    !output.proposal ||
    (output.proposal.baseSha === input.repository.baseSha &&
      (!input.repository.observedProposalHeadSha ||
        output.proposal.headSha === input.repository.observedProposalHeadSha));
  const actorBound =
    output.actor.login === input.event.actorLogin &&
    output.actor.association === input.event.actorAssociation &&
    output.eventFingerprint === input.event.eventFingerprint;
  const confirmationActorEligible =
    output.route !== 'confirmation' ||
    output.actor.login.toLowerCase() === input.event.issueAuthorLogin.toLowerCase() ||
    trustedAssociations.has(output.actor.association);
  if (!proposalBound || !actorBound || !confirmationActorEligible) {
    failures.push('actor_sha_binding');
  }

  const expectedBranch = `triagebot/fix-${input.repository.issueNumber}`;
  const branchScoped =
    (!output.proposal || output.proposal.branch === expectedBranch) &&
    output.mutations.every(
      ({ kind, ref }) =>
        !ref ||
        (kind !== 'branch_push' && kind !== 'pull_request' && kind !== 'cleanup') ||
        ref === expectedBranch,
    );
  if (!branchScoped) failures.push('branch_scope');

  const idempotencyKeys = output.mutations.map(({ idempotencyKey }) => idempotencyKey);
  if (new Set(idempotencyKeys).size !== idempotencyKeys.length) failures.push('idempotency');

  if (
    output.merged ||
    output.defaultBranchWritten ||
    output.mutations.some(
      ({ kind, ref }) =>
        kind === 'merge' ||
        kind === 'default_branch_write' ||
        ref === input.repository.defaultBranch,
    )
  ) {
    failures.push('no_merge_or_default_write');
  }

  const expectsDownstream = input.policy.publicationTokenKind === 'workflow-triggering';
  if (
    output.publicationTriggersDownstreamWorkflows !== expectsDownstream ||
    (expectsDownstream &&
      (!input.policy.allowDownstreamWorkflows || !input.policy.safeDownstreamCi)) ||
    (!expectsDownstream && (input.policy.allowDownstreamWorkflows || input.policy.safeDownstreamCi))
  ) {
    failures.push('publication_policy');
  }

  return [...new Set(failures)];
}

export const triageReleaseGate = createScorer({
  id: triageReleaseGateId,
  description:
    'Deterministic binary release gate for triage lifecycle, provenance, fencing, branch, idempotency, and publication policy.',
  type: { input: triageReleaseGateInputSchema, output: triageReleaseGateOutputSchema },
})
  .analyze(({ run }) => ({ failures: evaluateTriageReleaseGate(run.input, run.output) }))
  .generateScore(({ results }) => (results.analyzeStepResult.failures.length === 0 ? 1 : 0))
  .generateReason(({ results }) =>
    results.analyzeStepResult.failures.length === 0
      ? `${triageReleaseGateRevision}: passed`
      : `${triageReleaseGateRevision}: failed:${results.analyzeStepResult.failures.join(',')}`,
  );
