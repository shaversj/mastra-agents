import { describe, expect, it } from 'vitest';

import { mapStageResult } from '../src/domain/evidence.js';
import {
  decodeMarker,
  encodeMarker,
  reconcileMarkers,
  summarizeAttemptLedger,
} from '../src/domain/markers.js';
import {
  classifyProposalResponse,
  planProposalCleanup,
  proposalIdentity,
} from '../src/domain/proposal.js';

const proposal = proposalIdentity({
  baseSha: 'a'.repeat(40),
  branch: 'triagebot/fix-42',
  headSha: 'b'.repeat(40),
});

describe('recovery markers and proposals', () => {
  it('maps closed stage results to lifecycle states', () => {
    expect(mapStageResult({ outcome: 'missing_reproduction' })).toEqual({
      state: 'needs_reproduction',
    });
    expect(mapStageResult({ outcome: 'verified_fix', proposal })).toEqual({
      proposal,
      state: 'fix_pending',
    });
  });

  it('round-trips a versioned marker only for a verified action author', () => {
    const body = encodeMarker({
      eventFingerprint: 'issue_comment:created:1001:2001:5001:delivery-1',
      fencingToken: 'fence-1',
      generation: 3,
      issueNumber: 42,
      kind: 'proposal',
      proposal,
      repository: 'example/widgets',
      state: 'fix_pending',
    });

    expect(decodeMarker(body, { authorIsAction: false })).toBeNull();
    expect(decodeMarker(body, { authorIsAction: true })).toMatchObject({
      fencingToken: 'fence-1',
      kind: 'proposal',
      schemaVersion: 1,
    });
  });

  it('reports duplicate, proposal, and fencing conflicts explicitly', () => {
    const current = {
      eventFingerprint: 'event-1',
      fencingToken: 'fence-2',
      generation: 2,
      issueNumber: 42,
      kind: 'proposal' as const,
      proposal,
      repository: 'example/widgets',
      schemaVersion: 1 as const,
      state: 'fix_pending' as const,
    };

    expect(reconcileMarkers([current], { eventFingerprint: 'event-1' })).toEqual({
      kind: 'duplicate_event',
      marker: current,
    });
    expect(reconcileMarkers([current], { fencingToken: 'fence-old' })).toEqual({
      currentFencingToken: 'fence-2',
      kind: 'superseded_fence',
    });
    expect(
      reconcileMarkers([current], {
        proposal: { ...proposal, headSha: 'c'.repeat(40) },
      }),
    ).toEqual({
      activeProposal: proposal,
      kind: 'stale_proposal',
    });
  });

  it('derives generation-scoped budgets without deleting prior audit history', () => {
    const base = {
      eventFingerprint: 'event-1',
      fencingToken: 'fence-2',
      issueNumber: 42,
      repository: 'example/widgets',
      schemaVersion: 1 as const,
      state: 'failed' as const,
    };
    expect(
      summarizeAttemptLedger(
        [
          { ...base, generation: 1, kind: 'failure' },
          { ...base, eventFingerprint: 'event-2', generation: 2, kind: 'failure' },
          { ...base, eventFingerprint: 'event-3', generation: 2, kind: 'model_event' },
        ],
        2,
      ),
    ).toEqual({
      failureCount: 1,
      generation: 2,
      modelEventCount: 1,
      processedEventFingerprints: ['event-1', 'event-2', 'event-3'],
    });
  });

  it('binds confirmation and rejection to an eligible actor and exact proposal', () => {
    const exact = proposal.id;
    expect(
      classifyProposalResponse({
        actorAssociation: 'NONE',
        actorLogin: 'stranger',
        classification: 'confirmed',
        issueAuthorLogin: 'reporter',
        mentionedProposalId: exact,
        proposal,
        remoteHeadSha: proposal.headSha,
      }),
    ).toEqual({ kind: 'ineligible' });
    expect(
      classifyProposalResponse({
        actorAssociation: 'NONE',
        actorLogin: 'reporter',
        classification: 'confirmed',
        issueAuthorLogin: 'reporter',
        mentionedProposalId: 'old-proposal',
        proposal,
        remoteHeadSha: proposal.headSha,
      }),
    ).toEqual({ kind: 'inconclusive', reason: 'proposal_mismatch' });
    expect(
      classifyProposalResponse({
        actorAssociation: 'MEMBER',
        actorLogin: 'maintainer',
        classification: 'rejected',
        issueAuthorLogin: 'reporter',
        mentionedProposalId: exact,
        proposal,
        remoteHeadSha: proposal.headSha,
      }),
    ).toEqual({ kind: 'rejected', proposal });
    expect(
      classifyProposalResponse({
        actorAssociation: 'OWNER',
        actorLogin: 'owner',
        classification: 'confirmed',
        issueAuthorLogin: 'reporter',
        mentionedProposalId: exact,
        proposal,
        remoteHeadSha: 'c'.repeat(40),
      }),
    ).toEqual({ kind: 'stale', reason: 'branch_moved' });
  });

  it('deletes only an action-owned proposal branch unused by an open PR', () => {
    expect(
      planProposalCleanup({ actionOwnsBranch: true, hasOpenPullRequest: false, proposal }),
    ).toEqual({ branch: 'triagebot/fix-42', kind: 'delete' });
    expect(
      planProposalCleanup({ actionOwnsBranch: true, hasOpenPullRequest: true, proposal }),
    ).toEqual({ kind: 'retain', reason: 'open_pull_request' });
    expect(
      planProposalCleanup({ actionOwnsBranch: false, hasOpenPullRequest: false, proposal }),
    ).toEqual({ kind: 'conflict', reason: 'branch_not_action_owned' });
  });
});
