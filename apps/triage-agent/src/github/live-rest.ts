import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { proposalIdentity, type ProposalIdentity } from '../domain/proposal.js';
import { secureGitEnvironment } from '../security/git-environment.js';
import type { WorkflowRunStatus } from './lease.js';
import type {
  GitHubActionComment,
  GitHubMutationTransport,
  GitHubPullRequest,
} from './mutation-client.js';

const executeFile = promisify(execFile);

export interface GitHubResponse<T> {
  data: T;
  date: string;
  link?: string;
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

type GitExecutor = (
  file: string,
  args: readonly string[],
  options: {
    encoding: BufferEncoding;
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
  },
) => Promise<{ stderr: string; stdout: string }>;

function branchDeletionArguments(branch: string, expectedSha: string): string[] {
  if (
    !/^[0-9a-f]{40}$/u.test(expectedSha) ||
    !/^(?!\/)(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9._/-]{1,255}$/u.test(branch)
  ) {
    throw new Error('PROPOSAL_BRANCH_INVALID');
  }
  return [
    '-c',
    'credential.helper=',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'http.extraheader=',
    'push',
    `--force-with-lease=refs/heads/${branch}:${expectedSha}`,
    '--no-verify',
  ];
}

export async function deleteRemoteBranchWithLease(input: {
  branch: string;
  execute?: GitExecutor;
  expectedSha: string;
  remoteUrl: string;
  token: string;
}): Promise<void> {
  const parsedRemote = new URL(input.remoteUrl);
  if (
    parsedRemote.protocol !== 'https:' ||
    parsedRemote.username ||
    parsedRemote.password ||
    !input.token ||
    input.token.length > 4_096
  ) {
    throw new Error('PROPOSAL_BRANCH_DELETE_CONFIGURATION_INVALID');
  }
  const argumentsBeforeRemote = branchDeletionArguments(input.branch, input.expectedSha);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'triage-branch-delete-'));
  const askpassPath = join(temporaryRoot, 'git-askpass.sh');
  try {
    await writeFile(
      askpassPath,
      [
        '#!/bin/sh',
        'case "$1" in',
        '  *Username*) printf "%s\\n" "x-access-token" ;;',
        '  *) printf "%s\\n" "$TRIAGE_GIT_TOKEN" ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    await chmod(askpassPath, 0o700);
    const execute = input.execute ?? (executeFile as GitExecutor);
    await execute(
      'git',
      [...argumentsBeforeRemote, input.remoteUrl, `:refs/heads/${input.branch}`],
      {
        encoding: 'utf8',
        env: {
          ...secureGitEnvironment(),
          GIT_ASKPASS: askpassPath,
          GIT_ASKPASS_REQUIRE: 'force',
          TRIAGE_GIT_TOKEN: input.token,
        },
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      },
    );
  } catch (error) {
    throw new Error('PROPOSAL_BRANCH_DELETE_FAILED', { cause: error });
  } finally {
    await unlink(askpassPath).catch(() => undefined);
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export class GitHubRest implements GitHubMutationTransport {
  constructor(
    private readonly repository: string,
    private readonly token: string,
    private readonly apiUrl = 'https://api.github.com',
    private readonly actionLogin?: string,
    private readonly serverUrl = 'https://github.com',
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
      ...(response.headers.get('link') ? { link: response.headers.get('link') as string } : {}),
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

  async workflowRunStatus(
    workflowRunId: number,
    attempt: number,
  ): Promise<{ observedAt: string; status: WorkflowRunStatus; terminalAt?: string }> {
    const { data, date } = await this.request<{
      conclusion: string | null;
      status: 'completed' | 'in_progress' | 'queued';
      updated_at: string;
    }>('GET', `/actions/runs/${workflowRunId}/attempts/${attempt}`);
    if (data.status !== 'completed') return { observedAt: date, status: data.status };
    const terminalAt = new Date(data.updated_at).toISOString();
    if (
      data.conclusion === 'cancelled' ||
      data.conclusion === 'failure' ||
      data.conclusion === 'skipped' ||
      data.conclusion === 'timed_out'
    ) {
      return { observedAt: date, status: data.conclusion, terminalAt };
    }
    return { observedAt: date, status: 'completed', terminalAt };
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
    try {
      await deleteRemoteBranchWithLease({
        branch,
        expectedSha,
        remoteUrl: `${this.serverUrl.replace(/\/$/u, '')}/${this.repository}.git`,
        token: this.token,
      });
    } catch (error) {
      if ((await this.getBranchSha(branch)) !== expectedSha) {
        throw new Error('PROPOSAL_BRANCH_MOVED', { cause: error });
      }
      throw error;
    }
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
    const path = `/issues/${issueNumber}/comments`;
    const first = await this.request<RestComment[]>('GET', `${path}?per_page=100&page=1`);
    const lastPage = this.lastPage(first.link);
    const firstTailPage = Math.max(2, lastPage - 4);
    const remaining = await Promise.all(
      Array.from({ length: Math.max(0, lastPage - firstTailPage + 1) }, (_, index) =>
        this.request<RestComment[]>('GET', `${path}?per_page=100&page=${firstTailPage + index}`),
      ),
    );
    const data = [...(lastPage <= 5 ? [first] : []), ...remaining].flatMap(
      ({ data: comments }) => comments,
    );
    if (lastPage > 5) throw new Error('COMMENT_HISTORY_INCOMPLETE');
    if (data.length > 500) throw new Error('COMMENT_HISTORY_INCOMPLETE');
    return data.map((comment) => ({
      authorIsAction: comment.user.login === this.actionLogin,
      body: String(comment.body ?? '').slice(0, 100_000),
      id: comment.id,
    }));
  }

  async repositoryPermission(login: string): Promise<string> {
    try {
      const { data } = await this.request<{ permission: string }>(
        'GET',
        `/collaborators/${encodeURIComponent(login)}/permission`,
      );
      return data.permission;
    } catch (error) {
      if (error instanceof Error && error.message === 'GITHUB_API_404') return 'none';
      throw error;
    }
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

  private lastPage(link: string | undefined): number {
    if (!link) return 1;
    const last = link
      .split(',')
      .map((value) => value.trim())
      .find((value) => /;\s*rel="last"$/u.test(value));
    const match = last && /^<([^>]+)>;/u.exec(last);
    if (!match?.[1]) throw new Error('GITHUB_PAGINATION_INVALID');
    const page = Number(new URL(match[1]).searchParams.get('page'));
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('GITHUB_PAGINATION_INVALID');
    return page;
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
