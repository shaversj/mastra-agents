import type { LifecycleLabels, LifecycleState } from '../domain/lifecycle.js';
import { decodeMarker, encodeMarker, type RecoveryMarker } from '../domain/markers.js';
import type { ProposalIdentity } from '../domain/proposal.js';
import {
  assertAllowedLabels,
  assertSafeOutboundText,
  renderProposalComment,
  renderPullRequestContent,
  renderTriageReport,
  type TriageReportSemantics,
} from '../security/content-policy.js';
import type { PreviewResult } from '../preview/run-preview.js';
import type { FencedGitHubMutationClient, GitHubPullRequest } from './mutation-client.js';

export interface ReconciliationIdentity {
  eventFingerprint: string;
  fencingToken: string;
  generation: number;
  issueNumber: number;
  repository: string;
}

function markerFor(
  identity: ReconciliationIdentity,
  input: {
    kind: RecoveryMarker['kind'];
    proposal?: ProposalIdentity;
    resourceIds?: Record<string, string>;
    state: LifecycleState;
  },
): string {
  return encodeMarker({
    eventFingerprint: identity.eventFingerprint,
    fencingToken: identity.fencingToken,
    generation: identity.generation,
    issueNumber: identity.issueNumber,
    kind: input.kind,
    ...(input.proposal ? { proposal: input.proposal } : {}),
    repository: identity.repository,
    ...(input.resourceIds ? { resourceIds: input.resourceIds } : {}),
    state: input.state,
  });
}

async function hasMarker(
  api: FencedGitHubMutationClient,
  issueNumber: number,
  predicate: (marker: RecoveryMarker) => boolean,
): Promise<boolean> {
  const comments = await api.listComments(issueNumber);
  return comments.some((comment) => {
    const marker = decodeMarker(comment.body, { authorIsAction: comment.authorIsAction });
    return marker ? predicate(marker) : false;
  });
}

async function reconcileLifecycleLabel(input: {
  ancillaryLabels?: readonly string[];
  api: FencedGitHubMutationClient;
  issueNumber: number;
  labels: LifecycleLabels;
  target: LifecycleState;
}): Promise<void> {
  const current = [...(await input.api.readLabels(input.issueNumber))];
  const lifecycleValues = new Set(Object.values(input.labels));
  const currentLifecycle = current.filter((label) => lifecycleValues.has(label));
  if (currentLifecycle.length > 1) throw new Error('LIFECYCLE_LABEL_CONFLICT');
  const retained = current.filter((label) => !lifecycleValues.has(label));
  const next = [
    ...new Set([input.labels[input.target], ...retained, ...(input.ancillaryLabels ?? [])]),
  ];
  if (current.length === next.length && current.every((label, index) => label === next[index]))
    return;
  await input.api.setLabels(input.issueNumber, next);
}

export async function reconcileLifecycleState(input: {
  api: FencedGitHubMutationClient;
  issueNumber: number;
  labels: LifecycleLabels;
  target: LifecycleState;
}): Promise<void> {
  await reconcileLifecycleLabel(input);
}

export async function reconcileTriageReport(input: {
  api: FencedGitHubMutationClient;
  identity: ReconciliationIdentity;
  labels: LifecycleLabels;
  reasonCode: string;
  report: TriageReportSemantics;
  state: Exclude<LifecycleState, 'failed' | 'fix_pending' | 'fix_rejected' | 'fix_verified'>;
  stoppedAt: string;
}): Promise<void> {
  if (!/^[a-z0-9_]{1,100}$/u.test(input.reasonCode)) {
    throw new Error('OUTBOUND_REPORT_INVALID');
  }
  const visibleBody = renderTriageReport({
    report: input.report,
    state: input.state,
    stoppedAt: input.stoppedAt,
  });
  const existing = await hasMarker(
    input.api,
    input.identity.issueNumber,
    (marker) =>
      marker.kind === 'report' &&
      marker.eventFingerprint === input.identity.eventFingerprint &&
      marker.generation === input.identity.generation &&
      marker.state === input.state,
  );
  if (!existing) {
    await input.api.createComment(
      input.identity.issueNumber,
      `${visibleBody}\n\n${markerFor(input.identity, {
        kind: 'report',
        state: input.state,
      })}`,
    );
  }
  await reconcileLifecycleLabel({
    api: input.api,
    issueNumber: input.identity.issueNumber,
    labels: input.labels,
    target: input.state,
  });
}

export async function reconcileFixProposal(input: {
  allowedAncillaryLabels?: readonly string[];
  allowedPreviewHosts?: readonly string[];
  ancillaryLabels: readonly string[];
  api: FencedGitHubMutationClient;
  identity: ReconciliationIdentity;
  labels: LifecycleLabels;
  preview: PreviewResult;
  proposal: ProposalIdentity;
  report?: TriageReportSemantics;
}): Promise<{ proposal: ProposalIdentity; state: 'fix_pending' }> {
  const ancillaryLabels = assertAllowedLabels(
    input.ancillaryLabels,
    input.allowedAncillaryLabels ?? [],
  );
  const visibleBody = renderProposalComment({
    allowedPreviewHosts: input.allowedPreviewHosts ?? [],
    branch: input.proposal.branch,
    headSha: input.proposal.headSha,
    preview: input.preview,
    proposalId: input.proposal.id,
    ...(input.report ? { report: input.report } : {}),
  });
  const existing = await hasMarker(
    input.api,
    input.identity.issueNumber,
    (marker) =>
      marker.kind === 'proposal' &&
      marker.proposal?.id === input.proposal.id &&
      marker.state === 'fix_pending',
  );
  if (!existing) {
    await input.api.createComment(
      input.identity.issueNumber,
      `${visibleBody}\n\n${markerFor(input.identity, {
        kind: 'proposal',
        proposal: input.proposal,
        state: 'fix_pending',
      })}`,
    );
  }
  await reconcileLifecycleLabel({
    ancillaryLabels,
    api: input.api,
    issueNumber: input.identity.issueNumber,
    labels: input.labels,
    target: 'fix_pending',
  });
  return { proposal: input.proposal, state: 'fix_pending' };
}

export async function reconcileConfirmedProposal(input: {
  allowedPrHosts?: readonly string[];
  api: FencedGitHubMutationClient;
  identity: ReconciliationIdentity;
  labels: LifecycleLabels;
  prContent: { bodyFields: readonly string[]; title: string };
  proposal: ProposalIdentity;
  resolvedDefaultBranch: string;
}): Promise<{ pullRequest: GitHubPullRequest; state: 'fix_verified' }> {
  const rendered = renderPullRequestContent({
    ...(input.allowedPrHosts ? { allowedHosts: input.allowedPrHosts } : {}),
    bodyFields: input.prContent.bodyFields,
    proposalId: input.proposal.id,
    title: input.prContent.title,
  });
  if (input.resolvedDefaultBranch === input.proposal.branch) {
    throw new Error('PULL_REQUEST_BASE_INVALID');
  }
  const remoteHead = await input.api.getBranchSha(input.proposal.branch);
  if (remoteHead !== input.proposal.headSha) throw new Error('PROPOSAL_BRANCH_MOVED');
  const candidates = (
    await input.api.listPullRequests({
      base: input.resolvedDefaultBranch,
      head: input.proposal.branch,
    })
  ).filter(({ headSha }) => headSha === input.proposal.headSha);
  if (candidates.some(({ authorIsAction }) => !authorIsAction)) {
    throw new Error('PULL_REQUEST_OWNERSHIP_CONFLICT');
  }
  const matches = candidates.filter(({ authorIsAction }) => authorIsAction);
  if (matches.length > 1) throw new Error('PULL_REQUEST_CONFLICT');
  const existing = matches[0];
  const pullRequest =
    existing ??
    (await input.api.createPullRequest({
      base: input.resolvedDefaultBranch,
      body: rendered.body,
      head: input.proposal.branch,
      headSha: input.proposal.headSha,
      title: rendered.title,
    }));
  const transitionExists = await hasMarker(
    input.api,
    input.identity.issueNumber,
    (marker) =>
      marker.kind === 'transition' &&
      marker.proposal?.id === input.proposal.id &&
      marker.resourceIds?.['pullRequestId'] === String(pullRequest.id) &&
      marker.state === 'fix_verified',
  );
  if (!transitionExists) {
    const body = `Pull request #${pullRequest.id} exists for \`${input.proposal.id}\`.`;
    assertSafeOutboundText(body);
    await input.api.createComment(
      input.identity.issueNumber,
      `${body}\n\n${markerFor(input.identity, {
        kind: 'transition',
        proposal: input.proposal,
        resourceIds: { pullRequestId: String(pullRequest.id) },
        state: 'fix_verified',
      })}`,
    );
  }
  await reconcileLifecycleLabel({
    api: input.api,
    issueNumber: input.identity.issueNumber,
    labels: input.labels,
    target: 'fix_verified',
  });
  return { pullRequest, state: 'fix_verified' };
}

export async function reconcileRejectedProposal(input: {
  api: FencedGitHubMutationClient;
  identity: ReconciliationIdentity;
  labels: LifecycleLabels;
  proposal: ProposalIdentity;
}): Promise<{ proposal: ProposalIdentity; state: 'fix_rejected' }> {
  const existing = await hasMarker(
    input.api,
    input.identity.issueNumber,
    (marker) =>
      marker.kind === 'transition' &&
      marker.proposal?.id === input.proposal.id &&
      marker.state === 'fix_rejected',
  );
  if (!existing) {
    const body = `The reporter rejected proposal \`${input.proposal.id}\`; the branch is retained for diagnosis.`;
    assertSafeOutboundText(body);
    await input.api.createComment(
      input.identity.issueNumber,
      `${body}\n\n${markerFor(input.identity, {
        kind: 'transition',
        proposal: input.proposal,
        state: 'fix_rejected',
      })}`,
    );
  }
  await reconcileLifecycleLabel({
    api: input.api,
    issueNumber: input.identity.issueNumber,
    labels: input.labels,
    target: 'fix_rejected',
  });
  return { proposal: input.proposal, state: 'fix_rejected' };
}

export async function cleanupProposal(input: {
  actionOwnsBranch: boolean;
  api: FencedGitHubMutationClient;
  proposal: ProposalIdentity;
}): Promise<
  | { kind: 'conflict'; reason: 'branch_not_action_owned' | 'branch_moved' }
  | { kind: 'deleted' }
  | { kind: 'retained'; reason: 'open_pull_request' }
> {
  if (!input.actionOwnsBranch) return { kind: 'conflict', reason: 'branch_not_action_owned' };
  const openPullRequests = await input.api.listPullRequests({ head: input.proposal.branch });
  if (openPullRequests.some(({ open }) => open)) {
    return { kind: 'retained', reason: 'open_pull_request' };
  }
  const remoteHead = await input.api.getBranchSha(input.proposal.branch);
  if (remoteHead !== input.proposal.headSha) return { kind: 'conflict', reason: 'branch_moved' };
  await input.api.deleteBranch(input.proposal.branch, input.proposal.headSha);
  return { kind: 'deleted' };
}
