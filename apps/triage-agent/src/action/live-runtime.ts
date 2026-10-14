import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { ActionInputs } from './inputs.js';
import type {
  ActionControllerDependencies,
  ActionResult,
  ModelRuntime,
  RoutingSnapshot,
} from './run.js';
import { runRegisteredWorkflow, runTriageWorkflow } from './workflow-adapter.js';
import { appMetadata } from '../config/app.js';
import {
  defaultLifecycleLabels,
  type EventRoute,
  type LifecycleState,
} from '../domain/lifecycle.js';
import {
  decodeMarker,
  encodeMarker,
  summarizeAttemptLedger,
  type RecoveryMarker,
} from '../domain/markers.js';
import type { ProjectedGitHubEvent } from '../domain/event-projection.js';
import { proposalIdentity, type ProposalIdentity } from '../domain/proposal.js';
import { createHistoryAdapter } from '../git/history.js';
import { publishProposalBranch, type PublicationPolicyDecision } from '../git/repository.js';
import { createLiveLease } from '../github/live-lease.js';
import { GitHubRest } from '../github/live-rest.js';
import { FencedGitHubMutationClient } from '../github/mutation-client.js';
import {
  cleanupProposal,
  reconcileConfirmedProposal,
  reconcileFixProposal,
  reconcileLifecycleState,
  reconcileRejectedProposal,
  reconcileTriageReport,
  type ReconciliationIdentity,
} from '../github/reconcile.js';
import { createTriageMastra } from '../mastra/index.js';
import { triageCommentOutputSchema } from '../mastra/workflows/triage-comment.js';
import { triageWorkflowOutputSchema } from '../mastra/workflows/triage.js';
import {
  createHttpPreviewLauncher,
  parsePreviewInspectionOutput,
  runPreview,
} from '../preview/run-preview.js';
import { assertSafeOutboundText } from '../security/content-policy.js';
import { assertSafeGitEnvironment, secureGitEnvironment } from '../security/git-environment.js';
import { admitWorkspaceChanges, type AdmittedChanges } from '../security/diff-policy.js';
import {
  resolvePreparedDependencyPath,
  resolveProjectSkillFile,
} from '../security/project-paths.js';
import {
  createMaterializedWorkspace,
  assertDockerSandboxAvailable,
  type MaterializedWorkspace,
} from '../security/workspace.js';

const executeFile = promisify(execFile);
const trustedAssociations = new Set(['COLLABORATOR', 'MEMBER', 'OWNER']);

export { runRegisteredWorkflow } from './workflow-adapter.js';
export { priorLeaseOwnerDiffers } from '../github/live-lease.js';
export { deleteRemoteBranchWithLease } from '../github/live-rest.js';
export {
  resolvePreparedDependencyPath,
  resolveProjectSkillFile,
} from '../security/project-paths.js';

interface LiveEnvironment {
  GITHUB_API_URL?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_SERVER_URL?: string;
  GITHUB_SHA?: string;
  GITHUB_WORKSPACE?: string;
}

interface StoredState {
  actionLogin: string;
  proposal?: ProposalIdentity;
}

function recoveryRoute(
  markers: readonly RecoveryMarker[],
): Extract<EventRoute, { kind: 'recover' }> | undefined {
  if (markers.some(({ kind }) => kind === 'complete')) return undefined;
  const marker = markers.find(({ kind }) =>
    ['transition', 'proposal', 'report', 'failure'].includes(kind),
  );
  if (!marker) return undefined;
  const pullRequestId = Number(marker.resourceIds?.['pullRequestId']);
  return {
    generation: marker.generation,
    kind: 'recover',
    ...(marker.proposal ? { proposal: marker.proposal } : {}),
    ...(Number.isSafeInteger(pullRequestId) && pullRequestId > 0 ? { pullRequestId } : {}),
    recoveryKind: marker.kind as 'failure' | 'proposal' | 'report' | 'transition',
    state: marker.state,
  };
}

interface LiveModelRuntime extends ModelRuntime {
  admitted(): Promise<AdmittedChanges>;
  mastra: unknown;
  materialized: MaterializedWorkspace;
  workflowOutput?:
    | { kind: 'comment'; value: ReturnType<typeof triageCommentOutputSchema.parse> }
    | { kind: 'triage'; value: ReturnType<typeof triageWorkflowOutputSchema.parse> };
}

async function reconcilePullRequestLabel(
  api: FencedGitHubMutationClient,
  pullRequestId: number,
  label: string,
): Promise<void> {
  const current = [...(await api.readLabels(pullRequestId))];
  if (current.includes(label)) return;
  await api.setLabels(pullRequestId, [...current, label]);
}

async function ensureEventMarker(input: {
  api: FencedGitHubMutationClient;
  event: ProjectedGitHubEvent;
  fencingToken: string;
  generation: number;
  kind: 'complete' | 'failure' | 'model_event';
  proposal?: ProposalIdentity;
  state: LifecycleState;
}): Promise<void> {
  const comments = await input.api.listComments(input.event.issue.number);
  const exists = comments.some((comment) => {
    const marker = decodeMarker(comment.body, { authorIsAction: comment.authorIsAction });
    return marker?.eventFingerprint === input.event.eventFingerprint && marker.kind === input.kind;
  });
  if (exists) return;
  await input.api.createComment(
    input.event.issue.number,
    encodeMarker({
      eventFingerprint: input.event.eventFingerprint,
      fencingToken: input.fencingToken,
      generation: input.generation,
      issueNumber: input.event.issue.number,
      kind: input.kind,
      ...(input.proposal ? { proposal: input.proposal } : {}),
      repository: input.event.repository.fullName,
      state: input.state,
    }),
  );
}

async function sourceFiles(repositoryRoot: string): Promise<string[]> {
  const { stdout } = await executeFile('git', ['-C', repositoryRoot, 'ls-files', '-z'], {
    encoding: 'utf8',
    env: secureGitEnvironment(),
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean);
}

async function checkoutCredentialHygieneSafe(
  repositoryRoot: string,
  expectedSha: string | undefined,
): Promise<boolean> {
  if (!expectedSha || !/^[0-9a-f]{40}$/u.test(expectedSha)) return false;
  try {
    const [configuration, head] = await Promise.all([
      executeFile('git', ['-C', repositoryRoot, 'config', '--local', '--null', '--list'], {
        encoding: 'utf8',
        env: secureGitEnvironment(),
        maxBuffer: 1024 * 1024,
      }),
      executeFile('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD^{commit}'], {
        encoding: 'utf8',
        env: secureGitEnvironment(),
        maxBuffer: 1024 * 1024,
      }),
    ]);
    const config = configuration.stdout.toLowerCase();
    return (
      head.stdout.trim() === expectedSha &&
      !config.includes('credential.helper') &&
      !config.includes('extraheader') &&
      !/:\/\/[^/\0\n]*@/u.test(config)
    );
  } catch {
    return false;
  }
}

function providerEnvironment(inputs: ActionInputs): () => void {
  const changes: Array<[string, string | undefined]> = [];
  const set = (name: string, value: string | undefined) => {
    if (!value) return;
    changes.push([name, process.env[name]]);
    process.env[name] = value;
  };
  set('ANTHROPIC_API_KEY', inputs.anthropicApiKey);
  set('OPENAI_API_KEY', inputs.openaiApiKey);
  set('CLOUDFLARE_API_KEY', inputs.cloudflareApiKey);
  set('CLOUDFLARE_ACCOUNT_ID', inputs.cloudflareAccountId);
  return () => {
    for (const [name, value] of changes) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
}

export function createLiveActionDependencies(input: {
  environment: LiveEnvironment;
  inputs: ActionInputs;
  runWorkflow?: typeof runRegisteredWorkflow;
}): ActionControllerDependencies {
  const repository = input.environment.GITHUB_REPOSITORY;
  if (!repository) throw new Error('ACTION_GITHUB_REPOSITORY_MISSING');
  const states = new Map<string, StoredState>();
  let readApi: GitHubRest;
  let writeApi: GitHubRest;

  return {
    acquireLease: ({ abortSignal, event, workflowRunAttempt, workflowRunId }) =>
      createLiveLease(writeApi, event, workflowRunId, workflowRunAttempt, abortSignal),
    async createModelRuntime({ inputs, route }) {
      if (!inputs.triageSkill) throw new Error('MODEL_ROUTE_TRIAGE_SKILL_REQUIRED');
      const repositoryRoot = input.environment.GITHUB_WORKSPACE;
      if (!repositoryRoot) throw new Error('ACTION_GITHUB_WORKSPACE_MISSING');
      const triageSkillPath = await resolveProjectSkillFile(repositoryRoot, inputs.triageSkill);
      if (!triageSkillPath) throw new Error('MODEL_ROUTE_TRIAGE_SKILL_INVALID');
      const restoreProviderEnvironment = providerEnvironment(inputs);
      let materialized: MaterializedWorkspace | undefined;
      try {
        assertSafeGitEnvironment(process.env);
        const preparedPaths = await Promise.all(
          inputs.preparedDependencyPaths.map(async (path) => {
            const source = await resolvePreparedDependencyPath(repositoryRoot, path);
            if (!source) throw new Error('MODEL_ROUTE_PREPARED_DEPENDENCY_INVALID');
            return { source, target: path };
          }),
        );
        materialized = await createMaterializedWorkspace({
          ...(inputs.buildCommand ? { buildCommand: inputs.buildCommand } : {}),
          sourceFiles: await sourceFiles(repositoryRoot),
          sourceRoot: repositoryRoot,
          environment: process.env,
          preparedPaths,
          triageSkillPath,
        });
        const activeWorkspace = materialized;
        const evidenceSource = activeWorkspace.workspace.sandbox as
          | {
              drainCommandEvidence?: () => Array<{
                kind: 'command' | 'test';
                status: 'failed' | 'passed';
              }>;
            }
          | undefined;
        evidenceSource?.drainCommandEvidence?.();
        let admitted: AdmittedChanges | undefined;
        const prSkillRequired = route.kind === 'classify_fix_response' || inputs.autoPrOnFix;
        const prSkillPath =
          inputs.prSkill && prSkillRequired
            ? await resolveProjectSkillFile(repositoryRoot, inputs.prSkill)
            : undefined;
        if (inputs.prSkill && prSkillRequired && !prSkillPath) {
          throw new Error('MODEL_ROUTE_PR_SKILL_INVALID');
        }
        const prSkill = prSkillPath ? await readFile(prSkillPath, 'utf8') : undefined;
        const mastra = createTriageMastra({
          admitChanges: async () => {
            admitted = await admitWorkspaceChanges({
              baseline: activeWorkspace.baseline,
              workspaceRoot: activeWorkspace.workspaceRoot,
            });
            return admitted.changes.length > 0;
          },
          history: createHistoryAdapter({ repositoryRoot }),
          collectEvidence: async ({ phase }) =>
            (evidenceSource?.drainCommandEvidence?.() ?? []).map((entry) => ({
              ...entry,
              phase,
            })),
          model: inputs.triageModel,
          ...(prSkill ? { prSkill } : {}),
          verificationModel: inputs.verificationModel,
          workspace: activeWorkspace.workspace,
        });
        return {
          admitted: async () =>
            admitted ??
            admitWorkspaceChanges({
              baseline: activeWorkspace.baseline,
              workspaceRoot: activeWorkspace.workspaceRoot,
            }),
          async close() {
            try {
              await (
                mastra as { shutdown(input: { drainTimeout: number }): Promise<void> }
              ).shutdown({
                drainTimeout: 5_000,
              });
            } finally {
              try {
                await activeWorkspace.cleanup();
              } finally {
                restoreProviderEnvironment();
              }
            }
          },
          mastra,
          materialized: activeWorkspace,
        } satisfies LiveModelRuntime;
      } catch (error) {
        await materialized?.cleanup().catch(() => undefined);
        restoreProviderEnvironment();
        throw error;
      }
    },
    async executeRoute({ abortSignal, event, lease, route, runtime }) {
      if (route.kind === 'cleanup') return { reasonCode: 'CLEANUP_REQUESTED' };
      if (route.kind === 'conflict')
        return { reasonCode: 'LIFECYCLE_LABEL_CONFLICT', state: 'failed' };
      if (route.kind === 'recover') {
        return { reasonCode: 'PARTIAL_RECONCILIATION_RECOVERED', state: route.state };
      }
      const live = runtime as LiveModelRuntime;
      const state = states.get(event.eventFingerprint);
      if (!state) throw new Error('ACTION_LIVE_STATE_MISSING');
      await ensureEventMarker({
        api: new FencedGitHubMutationClient(writeApi, lease),
        event,
        fencingToken: lease.fencingToken,
        generation: route.generation,
        kind: 'model_event',
        state: route.kind === 'triage' ? 'needs_triage' : route.state,
      });
      if (route.kind === 'triage') {
        const output = await runTriageWorkflow({
          ...(abortSignal ? { abortSignal } : {}),
          baseSha: input.environment.GITHUB_SHA,
          event,
          generation: route.generation,
          inputs: input.inputs,
          mastra: live.mastra,
          ...(input.runWorkflow ? { runWorkflow: input.runWorkflow } : {}),
        });
        live.workflowOutput = { kind: 'triage', value: output };
        return {
          reasonCode:
            output.failureCode ?? output.mutationPlan?.kind.toUpperCase() ?? 'TRIAGE_COMPLETED',
          state: output.state,
        };
      }
      if (event.kind !== 'issue_comment') {
        throw new Error('COMMENT_CONTEXT_MISSING');
      }
      if (route.kind === 'classify_fix_response' && !state.proposal) {
        throw new Error('COMMENT_CONTEXT_MISSING');
      }
      const baseSha = input.environment.GITHUB_SHA;
      if (!baseSha) throw new Error('ACTION_CHECKOUT_CONTEXT_MISSING');
      const proposal =
        state.proposal ??
        proposalIdentity({
          baseSha,
          branch: `triagebot/fix-${event.issue.number}`,
          headSha: baseSha,
        });
      const remoteHeadSha = state.proposal
        ? await writeApi.getBranchSha(state.proposal.branch)
        : proposal.headSha;
      if (!remoteHeadSha) throw new Error('PROPOSAL_BRANCH_MISSING');
      const output = triageCommentOutputSchema.parse(
        await (input.runWorkflow ?? runRegisteredWorkflow)(
          live.mastra,
          appMetadata.workflowIds.comment,
          {
            actor: { association: event.actor.association, login: event.actor.login },
            issue: {
              body: event.issue.body,
              number: event.issue.number,
              reporterLogin: event.issue.reporterLogin,
              title: event.issue.title,
            },
            proposal,
            remoteHeadSha,
            route: route.kind === 'classify_fix_response' ? 'confirmation' : 'retriage',
            triggeringComment: { body: event.comment.body, id: event.comment.id },
          },
          abortSignal,
        ),
      );
      if (route.kind === 'classify_retriage' && output.action === 'rerun_triage') {
        const triageOutput = await runTriageWorkflow({
          ...(abortSignal ? { abortSignal } : {}),
          baseSha: input.environment.GITHUB_SHA,
          event,
          generation: route.generation,
          inputs: input.inputs,
          mastra: live.mastra,
          ...(input.runWorkflow ? { runWorkflow: input.runWorkflow } : {}),
          triggeringComment: { body: event.comment.body, id: event.comment.id },
        });
        live.workflowOutput = { kind: 'triage', value: triageOutput };
        return {
          reasonCode:
            triageOutput.failureCode ??
            triageOutput.mutationPlan?.kind.toUpperCase() ??
            'TRIAGE_COMPLETED',
          state: triageOutput.state,
        };
      }
      live.workflowOutput = { kind: 'comment', value: output };
      return { reasonCode: output.reasonCode, state: output.state };
    },
    inspectModelCapabilities: async ({ inputs, route }) => {
      const repositoryRoot = input.environment.GITHUB_WORKSPACE;
      const prSkillRequired = route.kind === 'classify_fix_response' || inputs.autoPrOnFix;
      const [
        triageSkillPath,
        prSkillPath,
        preparedDependencyPaths,
        repositoryLabels,
        checkoutSafe,
        sandboxAvailable,
      ] = await Promise.all([
        repositoryRoot && inputs.triageSkill
          ? resolveProjectSkillFile(repositoryRoot, inputs.triageSkill)
          : Promise.resolve(null),
        repositoryRoot && inputs.prSkill
          ? resolveProjectSkillFile(repositoryRoot, inputs.prSkill)
          : Promise.resolve(null),
        repositoryRoot
          ? Promise.all(
              inputs.preparedDependencyPaths.map((path) =>
                resolvePreparedDependencyPath(repositoryRoot, path),
              ),
            )
          : Promise.resolve([]),
        readApi.listRepositoryLabels(),
        repositoryRoot
          ? checkoutCredentialHygieneSafe(repositoryRoot, input.environment.GITHUB_SHA)
          : Promise.resolve(false),
        assertDockerSandboxAvailable().then(
          () => true,
          () => false,
        ),
      ]);
      if (preparedDependencyPaths.some((path) => !path)) {
        throw new Error('MODEL_ROUTE_PREPARED_DEPENDENCY_INVALID');
      }
      const availableLabels = new Set(repositoryLabels);
      const requiredLabels = new Set([
        ...Object.values(inputs.labels),
        ...inputs.allowedPackageLabels,
        ...inputs.allowedPriorityLabels,
        inputs.prFixVerifiedLabel,
      ]);
      return {
        checkoutSafe,
        labelsPresent: [...requiredLabels].every((label) => availableLabels.has(label)),
        prSkillPresent: !prSkillRequired || !inputs.prSkill || Boolean(prSkillPath),
        sandboxAvailable,
        triageSkillPresent: Boolean(triageSkillPath),
      };
    },
    loadModelInputs: async () => input.inputs,
    async readRoutingState(event): Promise<RoutingSnapshot> {
      const readIdentityApi = new GitHubRest(
        repository,
        input.inputs.readToken,
        input.environment.GITHUB_API_URL,
        undefined,
        input.environment.GITHUB_SERVER_URL,
      );
      const sharedIdentity = input.inputs.readToken === input.inputs.writeToken;
      const writeIdentityApi = sharedIdentity
        ? readIdentityApi
        : new GitHubRest(
            repository,
            input.inputs.writeToken,
            input.environment.GITHUB_API_URL,
            undefined,
            input.environment.GITHUB_SERVER_URL,
          );
      const readIdentityPromise = readIdentityApi.authenticatedUser();
      const [readIdentity, writeIdentity] = sharedIdentity
        ? await readIdentityPromise.then((identity) => [identity, identity] as const)
        : await Promise.all([readIdentityPromise, writeIdentityApi.authenticatedUser()]);
      const actionLogin = writeIdentity.login;
      const configuredPublicationPolicy = publicationPolicy(input.inputs, actionLogin);
      if (!configuredPublicationPolicy.authorized) throw new Error('PUBLICATION_POLICY_DENIED');
      readApi = new GitHubRest(
        repository,
        input.inputs.readToken,
        input.environment.GITHUB_API_URL,
        actionLogin,
        input.environment.GITHUB_SERVER_URL,
      );
      writeApi = new GitHubRest(
        repository,
        input.inputs.writeToken,
        input.environment.GITHUB_API_URL,
        actionLogin,
        input.environment.GITHUB_SERVER_URL,
      );
      const comments = await readApi.listComments(event.issue.number);
      const markers = comments.flatMap((comment) => {
        const marker = decodeMarker(comment.body, { authorIsAction: comment.authorIsAction });
        return marker?.repository === event.repository.fullName &&
          marker.issueNumber === event.issue.number
          ? [marker]
          : [];
      });
      const generation = Math.max(0, ...markers.map((marker) => marker.generation));
      const eventMarkers = markers.filter(
        ({ eventFingerprint }) => eventFingerprint === event.eventFingerprint,
      );
      let proposal: ProposalIdentity | undefined;
      for (let index = markers.length - 1; index >= 0; index -= 1) {
        const candidate = markers[index]?.proposal;
        if (candidate) {
          proposal = candidate;
          break;
        }
      }
      let recovery = recoveryRoute(eventMarkers);
      const modelMarker = eventMarkers.find(({ kind }) => kind === 'model_event');
      if (!proposal && modelMarker && input.environment.GITHUB_SHA) {
        proposal =
          (await readApi.readActionProposal({
            baseSha: input.environment.GITHUB_SHA,
            branch: `triagebot/fix-${event.issue.number}`,
            eventFingerprint: event.eventFingerprint,
            fencingToken: modelMarker.fencingToken,
            issueNumber: event.issue.number,
          })) ?? undefined;
        if (proposal && !input.inputs.autoPrOnFix) {
          recovery = {
            generation: modelMarker.generation,
            kind: 'recover',
            proposal,
            recoveryKind: 'proposal',
            state: 'fix_pending',
          };
        }
      }
      if (
        proposal &&
        !eventMarkers.some(({ kind }) => kind === 'complete') &&
        (input.inputs.autoPrOnFix || recovery?.state === 'fix_verified')
      ) {
        const pullRequestCandidates = (
          await readApi.listPullRequests({
            base: event.repository.defaultBranch,
            head: proposal.branch,
          })
        ).filter(
          (pullRequest) =>
            pullRequest.headSha === proposal.headSha &&
            pullRequest.body.includes(`Proposal: \`${proposal.id}\``) &&
            pullRequest.body.includes('This pull request was created by the triage agent.'),
        );
        if (pullRequestCandidates.some(({ authorIsAction }) => !authorIsAction)) {
          throw new Error('PULL_REQUEST_OWNERSHIP_CONFLICT');
        }
        const pullRequests = pullRequestCandidates.filter(({ authorIsAction }) => authorIsAction);
        if (pullRequests.length > 1) throw new Error('PULL_REQUEST_CONFLICT');
        const pullRequest = pullRequests[0];
        recovery = pullRequest
          ? {
              generation: eventMarkers[0]?.generation ?? generation,
              kind: 'recover',
              proposal,
              pullRequestId: pullRequest.id,
              recoveryKind: 'transition',
              state: 'fix_verified',
            }
          : recovery?.recoveryKind === 'proposal' && input.inputs.autoPrOnFix
            ? undefined
            : recovery;
      }
      states.set(event.eventFingerprint, { actionLogin, ...(proposal ? { proposal } : {}) });
      const trustedActor =
        input.inputs.activationPolicy !== 'trusted'
          ? false
          : event.kind === 'issue_comment'
            ? trustedAssociations.has(event.actor.association)
            : ['admin', 'maintain', 'write'].includes(
                await readApi.repositoryPermission(event.actor.login),
              );
      return {
        actionLogin,
        activationPolicy: input.inputs.activationPolicy,
        botLogins: input.inputs.botLogins,
        branchProvenanceVerified: proposal
          ? (await readApi.getBranchSha(proposal.branch)) === proposal.headSha
          : true,
        githubIdentityVerified: Boolean(actionLogin) && readIdentity.login === writeIdentity.login,
        ledger: summarizeAttemptLedger(markers, generation),
        lifecycleLabels: input.inputs.labels ?? defaultLifecycleLabels,
        maxModelEvents: input.inputs.maxModelEvents,
        ...(recovery ? { recovery } : {}),
        trustedActivation: trustedActor,
        trustedReset: trustedActor,
      };
    },
    async reconcileFailure({ event, lease, reasonCode, route }) {
      if (!/^[A-Z0-9_]{1,100}$/u.test(reasonCode)) {
        throw new Error('FAILURE_REASON_INVALID');
      }
      await lease.assertCurrent();
      const api = new FencedGitHubMutationClient(writeApi, lease);
      const proposal = states.get(event.eventFingerprint)?.proposal;
      await ensureEventMarker({
        api,
        event,
        fencingToken: lease.fencingToken,
        generation: route.generation,
        kind: 'failure',
        ...(proposal ? { proposal } : {}),
        state: 'failed',
      });
      await reconcileLifecycleState({
        api,
        issueNumber: event.issue.number,
        labels: input.inputs.labels,
        replaceConflicts: true,
        target: 'failed',
      });
      await ensureEventMarker({
        api,
        event,
        fencingToken: lease.fencingToken,
        generation: route.generation,
        kind: 'complete',
        state: 'failed',
      });
    },
    async reconcile({ event, execution, lease, route, runtime }) {
      await lease.assertCurrent();
      const state = states.get(event.eventFingerprint);
      if (!state) throw new Error('ACTION_LIVE_STATE_MISSING');
      const api = new FencedGitHubMutationClient(writeApi, lease);
      const identity: ReconciliationIdentity = {
        eventFingerprint: event.eventFingerprint,
        fencingToken: lease.fencingToken,
        generation: 'generation' in route ? route.generation : 0,
        issueNumber: event.issue.number,
        repository: event.repository.fullName,
      };
      let reasonCode = execution.reasonCode;
      let resultState = execution.state;
      let prUrl: string | undefined;
      if (route.kind === 'cleanup') {
        if (state.proposal) {
          const cleanup = await cleanupProposal({
            actionOwnsBranch: true,
            api,
            proposal: state.proposal,
          });
          reasonCode =
            cleanup.kind === 'deleted' ? 'PROPOSAL_BRANCH_DELETED' : cleanup.reason.toUpperCase();
        } else reasonCode = 'NO_ACTIVE_PROPOSAL';
      } else if (route.kind === 'conflict') {
        const body = 'Conflicting triage lifecycle labels require maintainer repair.';
        assertSafeOutboundText(body);
        await api.createComment(event.issue.number, body);
        await reconcileLifecycleState({
          api,
          issueNumber: event.issue.number,
          labels: input.inputs.labels,
          replaceConflicts: true,
          target: 'failed',
        });
      } else if (route.kind === 'recover') {
        if (route.recoveryKind === 'proposal') {
          if (
            !route.proposal ||
            (await api.getBranchSha(route.proposal.branch)) !== route.proposal.headSha
          ) {
            throw new Error('PROPOSAL_BRANCH_PROVENANCE_INVALID');
          }
          await reconcileFixProposal({
            allowedAncillaryLabels: [
              ...input.inputs.allowedPackageLabels,
              ...input.inputs.allowedPriorityLabels,
            ],
            ancillaryLabels: [],
            api,
            confirmationRequired: !input.inputs.autoPrOnFix,
            identity,
            labels: input.inputs.labels,
            preview: { status: 'skipped', urls: [] },
            proposal: route.proposal,
            report: {
              details: ['The previously published proposal is ready for testing.'],
              headline: 'A verified fix is ready',
            },
          });
          resultState = 'fix_pending';
        } else if (route.recoveryKind === 'transition' && route.state === 'fix_verified') {
          if (!route.proposal || !route.pullRequestId) {
            throw new Error('RECOVERY_PULL_REQUEST_PROVENANCE_MISSING');
          }
          const matches = (
            await api.listPullRequests({
              base: event.repository.defaultBranch,
              head: route.proposal.branch,
            })
          ).filter(
            ({ authorIsAction, headSha, id }) =>
              authorIsAction && headSha === route.proposal?.headSha && id === route.pullRequestId,
          );
          if (matches.length !== 1) throw new Error('RECOVERY_PULL_REQUEST_PROVENANCE_INVALID');
          await reconcilePullRequestLabel(
            api,
            route.pullRequestId,
            input.inputs.prFixVerifiedLabel,
          );
          await reconcileLifecycleState({
            api,
            issueNumber: event.issue.number,
            labels: input.inputs.labels,
            target: 'fix_verified',
          });
          resultState = 'fix_verified';
          prUrl = `https://github.com/${event.repository.fullName}/pull/${route.pullRequestId}`;
        } else {
          await reconcileLifecycleState({
            api,
            issueNumber: event.issue.number,
            labels: input.inputs.labels,
            target: route.state,
          });
          resultState = route.state;
        }
      } else {
        const live = runtime as LiveModelRuntime;
        if (live.workflowOutput?.kind === 'triage') {
          const output = live.workflowOutput.value;
          if (output.state === 'failed' || !output.mutationPlan) {
            await ensureEventMarker({
              api,
              event,
              fencingToken: lease.fencingToken,
              generation: route.generation,
              kind: 'failure',
              state: 'failed',
            });
            await reconcileLifecycleState({
              api,
              issueNumber: event.issue.number,
              labels: input.inputs.labels,
              replaceConflicts: true,
              target: 'failed',
            });
            reasonCode = output.failureCode ?? 'TRIAGE_FAILED';
            resultState = 'failed';
          } else if (output.mutationPlan?.kind === 'publish_proposal') {
            const baseSha = input.environment.GITHUB_SHA;
            const sourceRepositoryRoot = input.environment.GITHUB_WORKSPACE;
            if (!baseSha || !sourceRepositoryRoot)
              throw new Error('ACTION_CHECKOUT_CONTEXT_MISSING');
            const proposal = await publishProposalBranch({
              baseSha,
              branch: `triagebot/fix-${event.issue.number}`,
              changes: await live.admitted(),
              credential: { token: input.inputs.writeToken, username: 'x-access-token' },
              defaultBranch: event.repository.defaultBranch,
              eventFingerprint: event.eventFingerprint,
              ...(state.proposal
                ? {
                    existingBranchProvenance: {
                      actionAuthored: true as const,
                      branch: state.proposal.branch,
                      headSha: state.proposal.headSha,
                      issueNumber: event.issue.number,
                      repository: event.repository.fullName,
                    },
                  }
                : {}),
              issueNumber: event.issue.number,
              lease,
              fencingToken: lease.fencingToken,
              policy: publicationPolicy(input.inputs, state.actionLogin),
              remoteUrl: `https://github.com/${event.repository.fullName}.git`,
              repository: event.repository.fullName,
              sourceRepositoryRoot,
            });
            state.proposal = proposal;
            const previewCommand = input.inputs.previewCommand;
            const previewLaunchUrl = input.inputs.previewLaunchUrl;
            const previewToken = input.inputs.previewToken;
            const preview = await runPreview({
              allowedHosts: input.inputs.previewAllowedHosts,
              ...(previewCommand
                ? {
                    inspectChangedCode: async ({ environment, network }) => {
                      if (network || Object.keys(environment).length > 0) {
                        throw new Error('PREVIEW_INSPECTION_BOUNDARY_INVALID');
                      }
                      const result = await live.materialized.workspace.sandbox?.executeCommand?.(
                        previewCommand,
                        [],
                        { env: {}, maxRetainedBytes: 8_192 },
                      );
                      if (!result?.success || Buffer.byteLength(result.stdout) > 8_192) {
                        throw new Error('PREVIEW_INSPECTION_FAILED');
                      }
                      return parsePreviewInspectionOutput(result.stdout);
                    },
                    lease,
                    ...(previewLaunchUrl && previewToken
                      ? {
                          launch: createHttpPreviewLauncher({
                            allowedHosts: input.inputs.previewAllowedHosts,
                            endpoint: previewLaunchUrl,
                          }),
                          previewCredentials: { PREVIEW_TOKEN: previewToken },
                        }
                      : {}),
                    publication: {
                      branch: proposal.branch,
                      confirmed: true as const,
                      headSha: proposal.headSha,
                    },
                    workspaceRoot: live.materialized.workspaceRoot,
                  }
                : {}),
              metadata: {
                branch: proposal.branch,
                repository: event.repository.fullName,
                sha: proposal.headSha,
              },
            });
            await reconcileFixProposal({
              allowedAncillaryLabels: [
                ...input.inputs.allowedPackageLabels,
                ...input.inputs.allowedPriorityLabels,
              ],
              allowedPreviewHosts: input.inputs.previewAllowedHosts,
              ancillaryLabels: [
                ...output.mutationPlan.labels.packageLabels,
                ...(output.mutationPlan.labels.priorityLabel
                  ? [output.mutationPlan.labels.priorityLabel]
                  : []),
              ],
              api,
              confirmationRequired: !input.inputs.autoPrOnFix,
              identity,
              labels: input.inputs.labels,
              preview,
              proposal,
              report: output.mutationPlan.report,
            });
            if (input.inputs.autoPrOnFix && output.mutationPlan.prContent) {
              const reconciled = await reconcileConfirmedProposal({
                api,
                identity,
                labels: input.inputs.labels,
                prContent: output.mutationPlan.prContent,
                proposal,
                resolvedDefaultBranch: event.repository.defaultBranch,
              });
              await reconcilePullRequestLabel(
                api,
                reconciled.pullRequest.id,
                input.inputs.prFixVerifiedLabel,
              );
              prUrl = `https://github.com/${event.repository.fullName}/pull/${reconciled.pullRequest.id}`;
              resultState = reconciled.state;
            } else {
              resultState = 'fix_pending';
            }
          } else if (output.mutationPlan?.kind === 'triage_outcome') {
            await reconcileTriageReport({
              api,
              identity,
              labels: input.inputs.labels,
              reasonCode: output.mutationPlan.reasonCode,
              report: output.mutationPlan.report,
              state: output.mutationPlan.state,
              stoppedAt: output.stoppedAt,
            });
          }
        } else {
          if (!live.workflowOutput) throw new Error('ACTION_WORKFLOW_OUTPUT_MISSING');
          const output = live.workflowOutput.value;
          if (output.action === 'create_pull_request' && state.proposal && output.prContent) {
            const reconciled = await reconcileConfirmedProposal({
              api,
              identity,
              labels: input.inputs.labels,
              prContent: output.prContent,
              proposal: state.proposal,
              resolvedDefaultBranch: event.repository.defaultBranch,
            });
            await reconcilePullRequestLabel(
              api,
              reconciled.pullRequest.id,
              input.inputs.prFixVerifiedLabel,
            );
            prUrl = `https://github.com/${event.repository.fullName}/pull/${reconciled.pullRequest.id}`;
            resultState = reconciled.state;
          } else if (output.action === 'reject_proposal' && state.proposal) {
            resultState = (
              await reconcileRejectedProposal({
                api,
                identity,
                labels: input.inputs.labels,
                proposal: state.proposal,
              })
            ).state;
          }
        }
      }
      if (route.kind !== 'cleanup' && route.kind !== 'conflict' && resultState) {
        await ensureEventMarker({
          api,
          event,
          fencingToken: lease.fencingToken,
          generation: 'generation' in route ? route.generation : 0,
          kind: 'complete',
          state: resultState,
        });
      }
      return {
        appId: appMetadata.appId,
        issueNumber: event.issue.number,
        ...(prUrl ? { prUrl } : {}),
        reasonCode,
        repository: event.repository.fullName,
        route: route.kind,
        ...(resultState ? { state: resultState } : {}),
        status: 'completed',
      } satisfies ActionResult;
    },
  };
}

export function publicationPolicy(
  inputs: ActionInputs,
  authenticatedWriteLogin: string,
): PublicationPolicyDecision {
  return inputs.publicationTokenKind === 'github-token'
    ? authenticatedWriteLogin.toLowerCase() === 'github-actions[bot]'
      ? { authorized: true, kind: 'github-token', triggersDownstreamWorkflows: false }
      : { authorized: false, kind: 'github-token', triggersDownstreamWorkflows: false }
    : {
        authorized: inputs.allowDownstreamWorkflows && inputs.safeDownstreamCi,
        kind: 'workflow-triggering',
        triggersDownstreamWorkflows: true,
      };
}
