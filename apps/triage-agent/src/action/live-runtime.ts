import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { ActionInputs } from './inputs.js';
import type {
  ActionControllerDependencies,
  ActionLease,
  ActionResult,
  ModelRuntime,
  RoutingSnapshot,
} from './run.js';
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
import {
  createLeaseGuard,
  assertLeaseIdentity,
  decideLeaseAcquisition,
  leaseRefForIssue,
  type LeaseRecord,
  type WorkflowRunStatus,
} from '../github/lease.js';
import {
  FencedGitHubMutationClient,
  type GitHubActionComment,
  type GitHubMutationTransport,
  type GitHubPullRequest,
} from '../github/mutation-client.js';
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
import { parsePreviewInspectionOutput, runPreview } from '../preview/run-preview.js';
import { assertSafeOutboundText } from '../security/content-policy.js';
import { assertSafeGitEnvironment, secureGitEnvironment } from '../security/git-environment.js';
import { admitWorkspaceChanges, type AdmittedChanges } from '../security/diff-policy.js';
import {
  createMaterializedWorkspace,
  resolveSandboxIsolation,
  type MaterializedWorkspace,
} from '../security/workspace.js';

const executeFile = promisify(execFile);
const trustedAssociations = new Set(['COLLABORATOR', 'MEMBER', 'OWNER']);

interface LiveEnvironment {
  GITHUB_API_URL?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_SHA?: string;
  GITHUB_WORKSPACE?: string;
}

interface GitHubResponse<T> {
  data: T;
  date: string;
}

interface RestComment {
  body: string | null;
  id: number;
  user: { login: string };
}

interface RestPullRequest {
  base: { ref: string };
  body: string | null;
  head: { ref: string; sha: string };
  number: number;
  state: string;
  title: string;
  user: { login: string };
}

interface RestLabel {
  name: string;
}

class GitHubRest implements GitHubMutationTransport {
  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly apiUrl = 'https://api.github.com',
    private readonly actionLogin?: string,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<GitHubResponse<T>> {
    const response = await fetch(`${this.apiUrl}/repos/${this.repository}${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'mastra-triage-agent',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      method,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GITHUB_API_${response.status}`);
    const date = response.headers.get('date');
    if (!date || !Number.isFinite(Date.parse(date))) throw new Error('GITHUB_SERVER_TIME_MISSING');
    return {
      data: response.status === 204 ? (undefined as T) : ((await response.json()) as T),
      date: new Date(date).toISOString(),
    };
  }

  async authenticatedUser(): Promise<{ login: string }> {
    const response = await fetch(`${this.apiUrl}/user`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'mastra-triage-agent',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GITHUB_API_${response.status}`);
    return (await response.json()) as { login: string };
  }

  private async boundedPages<T>(
    path: string,
    maximumItems: number,
    maximumPages: number,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= maximumPages && items.length < maximumItems; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const { data } = await this.request<T[]>(
        'GET',
        `${path}${separator}per_page=100&page=${page}`,
      );
      items.push(...data.slice(0, maximumItems - items.length));
      if (data.length < 100) break;
    }
    return items;
  }

  async workflowRunStatus(workflowRunId: number, attempt: number): Promise<WorkflowRunStatus> {
    const { data } = await this.request<{
      conclusion: string | null;
      status: 'completed' | 'in_progress' | 'queued';
    }>('GET', `/actions/runs/${workflowRunId}/attempts/${attempt}`);
    if (data.status !== 'completed') return data.status;
    if (
      data.conclusion === 'cancelled' ||
      data.conclusion === 'failure' ||
      data.conclusion === 'skipped' ||
      data.conclusion === 'timed_out'
    ) {
      return data.conclusion;
    }
    return 'completed';
  }

  async createComment(issueNumber: number, body: string): Promise<GitHubActionComment> {
    const { data } = await this.request<{ body: string; id: number; user: { login: string } }>(
      'POST',
      `/issues/${issueNumber}/comments`,
      { body },
    );
    return { authorIsAction: data.user.login === this.actionLogin, body: data.body, id: data.id };
  }

  async createPullRequest(input: {
    base: string;
    body: string;
    head: string;
    headSha: string;
    title: string;
  }): Promise<GitHubPullRequest> {
    const { data } = await this.request<RestPullRequest>('POST', '/pulls', {
      base: input.base,
      body: input.body,
      head: input.head,
      title: input.title,
    });
    return pullRequest(data, this.actionLogin);
  }

  async deleteBranch(branch: string, expectedSha: string): Promise<void> {
    if ((await this.getBranchSha(branch)) !== expectedSha) throw new Error('PROPOSAL_BRANCH_MOVED');
    await this.request('DELETE', `/git/refs/heads/${encodeURIComponent(branch)}`);
  }

  async getBranchSha(branch: string): Promise<string | null> {
    try {
      const { data } = await this.request<{ object: { sha: string } }>(
        'GET',
        `/git/ref/heads/${encodeURIComponent(branch)}`,
      );
      return data.object.sha;
    } catch (error) {
      if (error instanceof Error && error.message === 'GITHUB_API_404') return null;
      throw error;
    }
  }

  async readActionProposal(input: {
    baseSha: string;
    branch: string;
    eventFingerprint: string;
    fencingToken: string;
    issueNumber: number;
  }): Promise<ProposalIdentity | null> {
    const headSha = await this.getBranchSha(input.branch);
    if (!headSha) return null;
    const { data } = await this.request<{ message: string; parents: Array<{ sha: string }> }>(
      'GET',
      `/git/commits/${headSha}`,
    );
    const trailers = new Map(
      data.message.split('\n').flatMap((line) => {
        const match = /^(Triage-Agent-[A-Za-z]+): (.+)$/u.exec(line);
        return match?.[1] && match[2] ? [[match[1], match[2]] as const] : [];
      }),
    );
    if (
      data.parents.length !== 1 ||
      data.parents[0]?.sha !== input.baseSha ||
      trailers.get('Triage-Agent-Repository') !== this.repository ||
      trailers.get('Triage-Agent-Issue') !== String(input.issueNumber) ||
      trailers.get('Triage-Agent-Branch') !== input.branch ||
      trailers.get('Triage-Agent-Base') !== input.baseSha ||
      trailers.get('Triage-Agent-Event') !== input.eventFingerprint ||
      trailers.get('Triage-Agent-Fence') !== input.fencingToken
    ) {
      return null;
    }
    return proposalIdentity({ baseSha: input.baseSha, branch: input.branch, headSha });
  }

  async listComments(issueNumber: number): Promise<readonly GitHubActionComment[]> {
    const data = await this.boundedPages<RestComment>(
      `/issues/${issueNumber}/comments?sort=created&direction=desc`,
      500,
      5,
    );
    return data.map((comment) => ({
      authorIsAction: comment.user.login === this.actionLogin,
      body: String(comment.body ?? '').slice(0, 100_000),
      id: comment.id,
    }));
  }

  async listPullRequests(input: {
    base?: string;
    head: string;
  }): Promise<readonly GitHubPullRequest[]> {
    const owner = this.repository.split('/')[0];
    if (!owner) throw new Error('GITHUB_REPOSITORY_INVALID');
    const query = new URLSearchParams({ head: `${owner}:${input.head}`, state: 'all' });
    if (input.base) query.set('base', input.base);
    const data = await this.boundedPages<RestPullRequest>(`/pulls?${query}`, 300, 3);
    return data.map((value) => pullRequest(value, this.actionLogin));
  }

  async listRepositoryLabels(): Promise<readonly string[]> {
    const data = await this.boundedPages<RestLabel>('/labels', 500, 5);
    return data.map(({ name }) => name);
  }

  async readLabels(issueNumber: number): Promise<readonly string[]> {
    const { data } = await this.request<{ labels: Array<{ name: string }> }>(
      'GET',
      `/issues/${issueNumber}`,
    );
    return data.labels.map(({ name }) => name);
  }

  async setLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.request('PUT', `/issues/${issueNumber}/labels`, { labels });
  }
}

function pullRequest(value: RestPullRequest, actionLogin: string | undefined): GitHubPullRequest {
  return {
    authorIsAction: Boolean(actionLogin) && value.user.login === actionLogin,
    base: value.base.ref,
    body: String(value.body ?? ''),
    head: value.head.ref,
    headSha: value.head.sha,
    id: value.number,
    open: value.state === 'open',
    title: value.title,
  };
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export async function resolveProjectSkillFile(
  repositoryRoot: string,
  configuredPath: string,
): Promise<string | undefined> {
  if (
    !configuredPath ||
    isAbsolute(configuredPath) ||
    configuredPath.includes('\\') ||
    /^[A-Za-z]:/u.test(configuredPath)
  ) {
    return undefined;
  }
  const segments = configuredPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return undefined;
  }

  const canonicalRoot = await realpath(repositoryRoot).catch(() => undefined);
  if (!canonicalRoot) return undefined;
  let candidate = canonicalRoot;
  for (const [index, segment] of [...segments, 'SKILL.md'].entries()) {
    candidate = resolve(candidate, segment);
    if (!isContained(canonicalRoot, candidate)) return undefined;
    const metadata = await lstat(candidate).catch(() => undefined);
    if (!metadata || metadata.isSymbolicLink()) return undefined;
    const isSkillFile = index === segments.length;
    if (isSkillFile ? !metadata.isFile() : !metadata.isDirectory()) return undefined;
  }

  const canonicalCandidate = await realpath(candidate).catch(() => undefined);
  return canonicalCandidate && isContained(canonicalRoot, canonicalCandidate)
    ? canonicalCandidate
    : undefined;
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

export async function runRegisteredWorkflow(
  mastra: unknown,
  workflowId: string,
  inputData: unknown,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  const registry = mastra as {
    getWorkflow(id: string): {
      createRun(): Promise<{
        cancel(): Promise<void>;
        start(input: {
          inputData: unknown;
          tracingOptions: { hideInput: true; hideOutput: true };
        }): Promise<
          { result: unknown; status: 'success' } | { status: Exclude<string, 'success'> }
        >;
      }>;
    };
  };
  abortSignal?.throwIfAborted();
  const run = await registry.getWorkflow(workflowId).createRun();
  abortSignal?.throwIfAborted();
  let removeAbortListener: () => void = () => undefined;
  const abortPromise = abortSignal
    ? new Promise<never>((_resolve, reject) => {
        let cancellationStarted = false;
        const cancel = () => {
          if (cancellationStarted) return;
          cancellationStarted = true;
          void run
            .cancel()
            .catch(() => undefined)
            .then(() => {
              reject(
                abortSignal.reason instanceof Error
                  ? abortSignal.reason
                  : new Error('ACTION_ABORTED'),
              );
            });
        };
        abortSignal.addEventListener('abort', cancel, { once: true });
        removeAbortListener = () => abortSignal.removeEventListener('abort', cancel);
        if (abortSignal.aborted) cancel();
      })
    : undefined;
  let result: { result: unknown; status: 'success' } | { status: Exclude<string, 'success'> };
  try {
    const started = run.start({
      inputData,
      tracingOptions: { hideInput: true, hideOutput: true },
    });
    result = abortPromise ? await Promise.race([started, abortPromise]) : await started;
  } finally {
    removeAbortListener();
  }
  if (result.status !== 'success' || !('result' in result)) {
    throw new Error('MASTRA_WORKFLOW_FAILED');
  }
  return result.result;
}

async function runTriageWorkflow(input: {
  abortSignal?: AbortSignal;
  environment: LiveEnvironment;
  event: ProjectedGitHubEvent;
  generation: number;
  inputs: ActionInputs;
  mastra: unknown;
  runWorkflow?: typeof runRegisteredWorkflow;
}): Promise<ReturnType<typeof triageWorkflowOutputSchema.parse>> {
  return triageWorkflowOutputSchema.parse(
    await (input.runWorkflow ?? runRegisteredWorkflow)(
      input.mastra,
      appMetadata.workflowIds.triage,
      {
        allowedPackageLabels: input.inputs.allowedPackageLabels,
        allowedPriorityLabels: input.inputs.allowedPriorityLabels,
        attemptId: input.event.eventFingerprint,
        autoPrOnFix: input.inputs.autoPrOnFix,
        eventFingerprint: input.event.eventFingerprint,
        generation: input.generation,
        issue: {
          body: input.event.issue.body,
          number: input.event.issue.number,
          reporterLogin: input.event.issue.reporterLogin,
          title: input.event.issue.title,
        },
        repository: {
          baseSha: input.environment.GITHUB_SHA,
          defaultBranch: input.event.repository.defaultBranch,
          fullName: input.event.repository.fullName,
        },
      },
      input.abortSignal,
    ),
  );
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

async function createLease(
  api: GitHubRest,
  event: ProjectedGitHubEvent,
  workflowRunId: number,
  workflowRunAttempt: number,
): Promise<ActionLease> {
  const ref = leaseRefForIssue(event.repository.id, event.issue.number).replace(/^refs\//u, '');
  const read = async (): Promise<{
    lease: LeaseRecord;
    refSha: string;
    serverNow: string;
  } | null> => {
    try {
      const reference = await api.request<{ object: { sha: string } }>('GET', `/git/ref/${ref}`);
      const commit = await api.request<{ tree: { sha: string } }>(
        'GET',
        `/git/commits/${reference.data.object.sha}`,
      );
      const tree = await api.request<{ tree: Array<{ path: string; sha: string }> }>(
        'GET',
        `/git/trees/${commit.data.tree.sha}`,
      );
      const blobSha = tree.data.tree.find(({ path }) => path === 'lease.json')?.sha;
      if (!blobSha) throw new Error('LEASE_BLOB_MISSING');
      const blob = await api.request<{ content: string }>('GET', `/git/blobs/${blobSha}`);
      const lease = JSON.parse(
        Buffer.from(blob.data.content, 'base64').toString('utf8'),
      ) as LeaseRecord;
      assertLeaseIdentity(lease, {
        issueNumber: event.issue.number,
        repository: event.repository.fullName,
      });
      return {
        lease,
        refSha: reference.data.object.sha,
        serverNow: reference.date,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'GITHUB_API_404') return null;
      throw error;
    }
  };
  const current = await read();
  const serverNow = current?.serverNow ?? (await api.request('GET', '')).date;
  const now = Date.parse(serverNow);
  const candidate: LeaseRecord =
    current?.lease.workflowRunId === workflowRunId &&
    current.lease.workflowRunAttempt === workflowRunAttempt
      ? current.lease
      : {
          acquiredAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 10 * 60_000).toISOString(),
          fencingToken: crypto.randomUUID(),
          issueNumber: event.issue.number,
          mutationDeadline: new Date(now + 9 * 60_000).toISOString(),
          repository: event.repository.fullName,
          workflowRunId,
          workflowRunAttempt,
        };
  const priorRunStatus =
    current && current.lease.workflowRunId !== workflowRunId
      ? await api.workflowRunStatus(current.lease.workflowRunId, current.lease.workflowRunAttempt)
      : undefined;
  const decision = decideLeaseAcquisition({
    candidate,
    current: current?.lease ?? null,
    maxApiTimeoutMs: 30_000,
    ...(priorRunStatus ? { priorRunStatus } : {}),
    serverNow,
    toleratedClockSkewMs: 5_000,
  });
  if (
    decision.kind !== 'acquired' &&
    decision.kind !== 'already_owned' &&
    decision.kind !== 'taken_over'
  ) {
    throw new Error('LEASE_CONTENDED');
  }
  const lease = decision.lease;
  if (decision.kind === 'acquired' || decision.kind === 'taken_over') {
    const blob = await api.request<{ sha: string }>('POST', '/git/blobs', {
      content: Buffer.from(JSON.stringify(lease)).toString('base64'),
      encoding: 'base64',
    });
    const tree = await api.request<{ sha: string }>('POST', '/git/trees', {
      tree: [{ mode: '100644', path: 'lease.json', sha: blob.data.sha, type: 'blob' }],
    });
    const commit = await api.request<{ sha: string }>('POST', '/git/commits', {
      message: `triage lease ${event.issue.number}`,
      parents: current ? [current.refSha] : [],
      tree: tree.data.sha,
    });
    try {
      if (decision.kind === 'acquired') {
        await api.request('POST', '/git/refs', { ref: `refs/${ref}`, sha: commit.data.sha });
      } else {
        await api.request('PATCH', `/git/refs/${ref}`, { force: false, sha: commit.data.sha });
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'GITHUB_API_422') {
        throw new Error('LEASE_CONTENDED', { cause: error });
      }
      throw error;
    }
  }
  const guard = createLeaseGuard({
    expected: { fencingToken: lease.fencingToken, workflowRunAttempt, workflowRunId },
    readCurrent: async () => {
      const value = await read();
      if (!value) throw new Error('LEASE_LOST_MISSING');
      return value;
    },
  });
  return {
    assertCurrent: () => guard.assertCurrent(),
    fencingToken: lease.fencingToken,
    async release() {
      // Retaining the terminal record avoids a racy delete. The next run takes it over with a
      // fast-forward compare-and-swap after GitHub reports this workflow terminal.
    },
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
    acquireLease: ({ event, workflowRunAttempt, workflowRunId }) =>
      createLease(writeApi, event, workflowRunId, workflowRunAttempt),
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
        materialized = await createMaterializedWorkspace({
          ...(inputs.buildCommand ? { buildCommand: inputs.buildCommand } : {}),
          sourceFiles: await sourceFiles(repositoryRoot),
          sourceRoot: repositoryRoot,
          environment: process.env,
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
          environment: input.environment,
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
            issue: { number: event.issue.number, reporterLogin: event.issue.reporterLogin },
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
          environment: input.environment,
          event,
          generation: route.generation,
          inputs: input.inputs,
          mastra: live.mastra,
          ...(input.runWorkflow ? { runWorkflow: input.runWorkflow } : {}),
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
      const [triageSkillPath, prSkillPath, repositoryLabels, checkoutSafe] = await Promise.all([
        repositoryRoot && inputs.triageSkill
          ? resolveProjectSkillFile(repositoryRoot, inputs.triageSkill)
          : Promise.resolve(null),
        repositoryRoot && inputs.prSkill
          ? resolveProjectSkillFile(repositoryRoot, inputs.prSkill)
          : Promise.resolve(null),
        readApi.listRepositoryLabels(),
        repositoryRoot
          ? checkoutCredentialHygieneSafe(repositoryRoot, input.environment.GITHUB_SHA)
          : Promise.resolve(false),
      ]);
      const availableLabels = new Set(repositoryLabels);
      const requiredLabels = new Set([
        ...Object.values(inputs.labels),
        ...inputs.allowedPackageLabels,
        ...inputs.allowedPriorityLabels,
        inputs.prFixVerifiedLabel,
      ]);
      let sandboxAvailable = false;
      try {
        resolveSandboxIsolation();
        sandboxAvailable = true;
      } catch {
        sandboxAvailable = false;
      }
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
      );
      const sharedIdentity = input.inputs.readToken === input.inputs.writeToken;
      const writeIdentityApi = sharedIdentity
        ? readIdentityApi
        : new GitHubRest(repository, input.inputs.writeToken, input.environment.GITHUB_API_URL);
      const readIdentityPromise = readIdentityApi.authenticatedUser();
      const [readIdentity, writeIdentity] = sharedIdentity
        ? await readIdentityPromise.then((identity) => [identity, identity] as const)
        : await Promise.all([readIdentityPromise, writeIdentityApi.authenticatedUser()]);
      const actionLogin = writeIdentity.login;
      readApi = new GitHubRest(
        repository,
        input.inputs.readToken,
        input.environment.GITHUB_API_URL,
        actionLogin,
      );
      writeApi = new GitHubRest(
        repository,
        input.inputs.writeToken,
        input.environment.GITHUB_API_URL,
        actionLogin,
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
      let proposal = markers.find((marker) => marker.proposal)?.proposal;
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
        trustedActivation: trustedAssociations.has(event.actor.association),
        trustedReset: trustedAssociations.has(event.actor.association),
      };
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
        await api.setLabels(event.issue.number, [input.inputs.labels.failed]);
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
            await api.setLabels(event.issue.number, [input.inputs.labels.failed]);
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
              policy: publicationPolicy(input.inputs),
              remoteUrl: `https://github.com/${event.repository.fullName}.git`,
              repository: event.repository.fullName,
              sourceRepositoryRoot,
            });
            const previewCommand = input.inputs.previewCommand;
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

function publicationPolicy(inputs: ActionInputs): PublicationPolicyDecision {
  return inputs.publicationTokenKind === 'github-token'
    ? { authorized: true, kind: 'github-token', triggersDownstreamWorkflows: false }
    : {
        authorized: inputs.allowDownstreamWorkflows && inputs.safeDownstreamCi,
        kind: 'workflow-triggering',
        triggersDownstreamWorkflows: true,
      };
}
