import { z } from 'zod';

import type { AttemptLedger, LifecycleState } from './lifecycle.js';
import { lifecycleStates } from './lifecycle.js';
import { proposalIdentity, type ProposalIdentity } from './proposal.js';

const markerPrefix = '<!-- triage-agent:v1:';
const markerSuffix = ' -->';
const maximumEncodedMarkerLength = 8_192;

const proposalSchema = z.object({
  baseSha: z.string(),
  branch: z.string(),
  headSha: z.string(),
  id: z.string(),
});
const markerSchema = z.object({
  eventFingerprint: z.string().min(1).max(500),
  fencingToken: z.string().min(1).max(200),
  generation: z.number().int().nonnegative(),
  issueNumber: z.number().int().positive(),
  kind: z.enum(['complete', 'failure', 'model_event', 'proposal', 'report', 'reset', 'transition']),
  proposal: proposalSchema.optional(),
  repository: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[^/\s]+\/[^/\s]+$/u),
  resourceIds: z.record(z.string().min(1).max(80), z.string().min(1).max(200)).optional(),
  schemaVersion: z.literal(1),
  state: z.enum(lifecycleStates),
});

export type RecoveryMarker = z.infer<typeof markerSchema>;
export type RecoveryMarkerInput = Omit<RecoveryMarker, 'schemaVersion'>;

export function encodeMarker(marker: RecoveryMarkerInput): string {
  const parsed = markerSchema.parse({ ...marker, schemaVersion: 1 });
  const encoded = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url');
  if (encoded.length > maximumEncodedMarkerLength) throw new Error('MARKER_TOO_LARGE');
  return `${markerPrefix}${encoded}${markerSuffix}`;
}

export function decodeMarker(
  body: string,
  verification: { authorIsAction: boolean },
): RecoveryMarker | null {
  if (!verification.authorIsAction || body.length > 100_000) return null;
  const start = body.indexOf(markerPrefix);
  if (start < 0) return null;
  const encodedStart = start + markerPrefix.length;
  const end = body.indexOf(markerSuffix, encodedStart);
  if (end < 0) return null;
  const encoded = body.slice(encodedStart, end);
  if (
    !encoded ||
    encoded.length > maximumEncodedMarkerLength ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    return null;
  }
  try {
    const parsed = markerSchema.safeParse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    );
    if (!parsed.success) return null;
    if (parsed.data.proposal) {
      const normalized = proposalIdentity(parsed.data.proposal);
      if (normalized.id !== parsed.data.proposal.id) return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function summarizeAttemptLedger(
  markers: readonly RecoveryMarker[],
  generation: number,
): AttemptLedger {
  const generationMarkers = markers.filter((marker) => marker.generation === generation);
  return {
    failureCount: generationMarkers.filter(({ kind }) => kind === 'failure').length,
    generation,
    modelEventCount: generationMarkers.filter(({ kind }) => kind === 'model_event').length,
    processedEventFingerprints: [
      ...new Set(
        markers
          .filter(({ kind }) => kind === 'complete')
          .map(({ eventFingerprint }) => eventFingerprint),
      ),
    ],
  };
}

export type MarkerReconciliation =
  | { kind: 'absent' }
  | { kind: 'conflict'; reason: 'multiple_active_proposals' }
  | { kind: 'duplicate_event'; marker: RecoveryMarker }
  | { kind: 'in_sync'; marker: RecoveryMarker }
  | { expected: LifecycleState; kind: 'partial_state'; observed: LifecycleState }
  | { activeProposal: ProposalIdentity; kind: 'stale_proposal' }
  | { currentFencingToken: string; kind: 'superseded_fence' };

function latest(markers: readonly RecoveryMarker[]): RecoveryMarker | undefined {
  return markers.at(-1);
}

export function reconcileMarkers(
  markers: readonly RecoveryMarker[],
  expected: {
    eventFingerprint?: string;
    fencingToken?: string;
    proposal?: ProposalIdentity;
    state?: LifecycleState;
  },
): MarkerReconciliation {
  if (expected.eventFingerprint) {
    const duplicate = markers.find(
      ({ eventFingerprint, kind }) =>
        kind === 'complete' && eventFingerprint === expected.eventFingerprint,
    );
    if (duplicate) return { kind: 'duplicate_event', marker: duplicate };
  }

  const current = latest(markers);
  if (!current) return { kind: 'absent' };
  if (expected.fencingToken && current.fencingToken !== expected.fencingToken) {
    return { currentFencingToken: current.fencingToken, kind: 'superseded_fence' };
  }

  if (expected.proposal) {
    const activeProposals = markers
      .filter((marker): marker is RecoveryMarker & { proposal: ProposalIdentity } =>
        Boolean(marker.proposal),
      )
      .map(({ proposal }) => proposal);
    const identities = new Set(activeProposals.map(({ id }) => id));
    if (identities.size > 1) return { kind: 'conflict', reason: 'multiple_active_proposals' };
    const activeProposal = activeProposals.at(-1);
    if (
      !activeProposal ||
      activeProposal.id !== expected.proposal.id ||
      activeProposal.baseSha !== expected.proposal.baseSha ||
      activeProposal.branch !== expected.proposal.branch ||
      activeProposal.headSha !== expected.proposal.headSha
    ) {
      return { activeProposal: activeProposal ?? expected.proposal, kind: 'stale_proposal' };
    }
  }
  if (expected.state && current.state !== expected.state) {
    return { expected: expected.state, kind: 'partial_state', observed: current.state };
  }
  return { kind: 'in_sync', marker: current };
}
