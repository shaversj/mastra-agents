import type { LeaseGuard } from './lease.js';

export interface GitHubActionComment {
  authorIsAction: boolean;
  body: string;
  id: number;
}

export interface GitHubPullRequest {
  authorIsAction: boolean;
  base: string;
  body: string;
  head: string;
  headSha: string;
  id: number;
  open: boolean;
  title: string;
}

export interface GitHubMutationTransport {
  createComment(issueNumber: number, body: string): Promise<GitHubActionComment>;
  createPullRequest(input: {
    base: string;
    body: string;
    head: string;
    headSha: string;
    title: string;
  }): Promise<GitHubPullRequest>;
  deleteBranch(branch: string, expectedSha: string): Promise<void>;
  getBranchSha(branch: string): Promise<string | null>;
  listComments(issueNumber: number): Promise<readonly GitHubActionComment[]>;
  listPullRequests(input: { base?: string; head: string }): Promise<readonly GitHubPullRequest[]>;
  readLabels(issueNumber: number): Promise<readonly string[]>;
  setLabels(issueNumber: number, labels: string[]): Promise<void>;
}

export class FencedGitHubMutationClient {
  constructor(
    private readonly transport: GitHubMutationTransport,
    private readonly lease: LeaseGuard,
  ) {}

  createComment(issueNumber: number, body: string): Promise<GitHubActionComment> {
    return this.mutate(() => this.transport.createComment(issueNumber, body));
  }

  createPullRequest(input: {
    base: string;
    body: string;
    head: string;
    headSha: string;
    title: string;
  }): Promise<GitHubPullRequest> {
    return this.mutate(() => this.transport.createPullRequest(input));
  }

  deleteBranch(branch: string, expectedSha: string): Promise<void> {
    return this.mutate(() => this.transport.deleteBranch(branch, expectedSha));
  }

  getBranchSha(branch: string): Promise<string | null> {
    return this.transport.getBranchSha(branch);
  }

  listComments(issueNumber: number): Promise<readonly GitHubActionComment[]> {
    return this.transport.listComments(issueNumber);
  }

  listPullRequests(input: { base?: string; head: string }): Promise<readonly GitHubPullRequest[]> {
    return this.transport.listPullRequests(input);
  }

  readLabels(issueNumber: number): Promise<readonly string[]> {
    return this.transport.readLabels(issueNumber);
  }

  setLabels(issueNumber: number, labels: string[]): Promise<void> {
    return this.mutate(() => this.transport.setLabels(issueNumber, labels));
  }

  private async mutate<TResult>(mutation: () => Promise<TResult>): Promise<TResult> {
    await this.lease.assertCurrent();
    return mutation();
  }
}
