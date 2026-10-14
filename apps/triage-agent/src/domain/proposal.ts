import type { ActorAssociation } from './event-projection.js';

const shaPattern = /^[0-9a-f]{40}$/u;
const branchPattern = /^triagebot\/fix-[1-9][0-9]*$/u;

export interface ProposalIdentity {
  baseSha: string;
  branch: string;
  headSha: string;
  id: string;
}

export function proposalIdentity(input: {
  baseSha: string;
  branch: string;
  headSha: string;
}): ProposalIdentity {
  if (!shaPattern.test(input.baseSha) || !shaPattern.test(input.headSha)) {
    throw new Error('PROPOSAL_SHA_INVALID');
  }
  if (!branchPattern.test(input.branch)) throw new Error('PROPOSAL_BRANCH_INVALID');
  return { ...input, id: `${input.branch}@${input.headSha}` };
}

const eligibleAssociations = new Set<ActorAssociation>(['COLLABORATOR', 'MEMBER', 'OWNER']);

export type ProposalResponse =
  | { kind: 'confirmed'; proposal: ProposalIdentity }
  | { kind: 'inconclusive'; reason: 'classification_inconclusive' | 'proposal_mismatch' }
  | { kind: 'ineligible' }
  | { kind: 'rejected'; proposal: ProposalIdentity }
  | { kind: 'stale'; reason: 'branch_moved' };

export function classifyProposalResponse(input: {
  actorAssociation: ActorAssociation;
  actorLogin: string;
  classification: 'confirmed' | 'inconclusive' | 'rejected';
  issueAuthorLogin: string;
  mentionedProposalId?: string;
  proposal: ProposalIdentity;
  remoteHeadSha: string;
}): ProposalResponse {
  if (
    input.actorLogin.toLowerCase() !== input.issueAuthorLogin.toLowerCase() &&
    !eligibleAssociations.has(input.actorAssociation)
  ) {
    return { kind: 'ineligible' };
  }
  if (input.classification === 'inconclusive') {
    return { kind: 'inconclusive', reason: 'classification_inconclusive' };
  }
  if (input.mentionedProposalId !== input.proposal.id) {
    return { kind: 'inconclusive', reason: 'proposal_mismatch' };
  }
  if (input.remoteHeadSha !== input.proposal.headSha)
    return { kind: 'stale', reason: 'branch_moved' };
  return input.classification === 'confirmed'
    ? { kind: 'confirmed', proposal: input.proposal }
    : { kind: 'rejected', proposal: input.proposal };
}

export type CleanupPlan =
  | { branch: string; kind: 'delete' }
  | { kind: 'conflict'; reason: 'branch_not_action_owned' }
  | { kind: 'retain'; reason: 'open_pull_request' };

export function planProposalCleanup(input: {
  actionOwnsBranch: boolean;
  hasOpenPullRequest: boolean;
  proposal: ProposalIdentity;
}): CleanupPlan {
  if (!input.actionOwnsBranch) return { kind: 'conflict', reason: 'branch_not_action_owned' };
  if (input.hasOpenPullRequest) return { kind: 'retain', reason: 'open_pull_request' };
  return { branch: input.proposal.branch, kind: 'delete' };
}
