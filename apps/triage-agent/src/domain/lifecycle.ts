import type { ProjectedGitHubEvent } from './event-projection.js';
import type { ProposalIdentity } from './proposal.js';

export const lifecycleStates = [
  'needs_triage',
  'not_actionable',
  'needs_reproduction',
  'skipped',
  'unable_to_reproduce',
  'unable_to_fix',
  'failed',
  'fix_pending',
  'fix_rejected',
  'fix_verified',
] as const;

export type LifecycleState = (typeof lifecycleStates)[number];
export type LifecycleLabels = Readonly<Record<LifecycleState, string>>;

export const defaultLifecycleLabels: LifecycleLabels = {
  failed: 'triage: failed',
  fix_pending: 'triage: fix pending',
  fix_rejected: 'triage: fix rejected',
  fix_verified: 'triage: fix verified',
  needs_reproduction: 'triage: needs reproduction',
  needs_triage: 'triage: needs triage',
  not_actionable: 'triage: not actionable',
  skipped: 'triage: skipped',
  unable_to_fix: 'triage: unable to fix',
  unable_to_reproduce: 'triage: unable to reproduce',
};

export const retriableStates = new Set<LifecycleState>([
  'failed',
  'fix_rejected',
  'needs_reproduction',
  'unable_to_fix',
  'unable_to_reproduce',
]);
export const terminalStates = new Set<LifecycleState>([
  'fix_verified',
  'not_actionable',
  'skipped',
]);

export interface AttemptLedger {
  failureCount: number;
  generation: number;
  modelEventCount: number;
  processedEventFingerprints: string[];
}

export interface AncillaryLabelSelection {
  packageLabels: string[];
  priorityLabel?: string;
}

export function selectAllowedAncillaryLabels(input: {
  allowedPackageLabels: readonly string[];
  allowedPriorityLabels: readonly string[];
  requestedPackageLabels: readonly string[];
  requestedPriorityLabel?: string;
}): AncillaryLabelSelection {
  const packageLabels = [
    ...new Set(
      input.requestedPackageLabels.filter((label) => input.allowedPackageLabels.includes(label)),
    ),
  ].slice(0, 3);
  const priorityLabel =
    input.requestedPriorityLabel &&
    input.allowedPriorityLabels.includes(input.requestedPriorityLabel)
      ? input.requestedPriorityLabel
      : undefined;
  return {
    packageLabels,
    ...(priorityLabel ? { priorityLabel } : {}),
  };
}

export type LifecycleLabelResult =
  | { kind: 'conflict'; labels: string[]; states: LifecycleState[] }
  | { kind: 'current'; label: string; state: LifecycleState }
  | { kind: 'missing' };

export function reconcileLifecycleLabels(
  issueLabels: readonly string[],
  configured: LifecycleLabels,
): LifecycleLabelResult {
  const found = lifecycleStates.flatMap((state) =>
    issueLabels.includes(configured[state]) ? [{ label: configured[state], state }] : [],
  );
  if (found.length === 0) return { kind: 'missing' };
  if (found.length === 1) {
    const current = found[0];
    if (!current) throw new Error('LIFECYCLE_STATE_UNREACHABLE');
    return { kind: 'current', ...current };
  }
  return {
    kind: 'conflict',
    labels: found.map(({ label }) => label),
    states: found.map(({ state }) => state),
  };
}

const transitions: Readonly<Record<LifecycleState, ReadonlySet<LifecycleState>>> = {
  failed: new Set(['needs_triage']),
  fix_pending: new Set(['fix_pending', 'fix_rejected', 'fix_verified']),
  fix_rejected: new Set(['needs_triage']),
  fix_verified: new Set(),
  needs_reproduction: new Set(['needs_triage']),
  needs_triage: new Set([
    'failed',
    'fix_pending',
    'fix_verified',
    'needs_reproduction',
    'not_actionable',
    'skipped',
    'unable_to_fix',
    'unable_to_reproduce',
  ]),
  not_actionable: new Set(),
  skipped: new Set(),
  unable_to_fix: new Set(['needs_triage']),
  unable_to_reproduce: new Set(['needs_triage']),
};

export type TransitionResult =
  | { kind: 'illegal_transition'; from: LifecycleState; to: LifecycleState }
  | { kind: 'transition'; state: LifecycleState };

export function transitionLifecycle(from: LifecycleState, to: LifecycleState): TransitionResult {
  return transitions[from].has(to)
    ? { kind: 'transition', state: to }
    : { from, kind: 'illegal_transition', to };
}

export type EventRoute =
  | { kind: 'cleanup'; issueNumber: number }
  | { kind: 'conflict'; labels: string[]; states: LifecycleState[] }
  | {
      generation: number;
      kind: 'recover';
      proposal?: ProposalIdentity;
      pullRequestId?: number;
      recoveryKind: 'failure' | 'proposal' | 'report' | 'transition';
      state: LifecycleState;
    }
  | { commentId: number; generation: number; kind: 'classify_fix_response'; state: 'fix_pending' }
  | { commentId: number; generation: number; kind: 'classify_retriage'; state: LifecycleState }
  | {
      eventFingerprint: string;
      generation: number;
      kind: 'triage';
      resetBudgets: boolean;
    }
  | {
      kind: 'noop';
      reason:
        | 'awaiting_trusted_activation'
        | 'bot_comment'
        | 'duplicate_event'
        | 'failure_budget_exhausted'
        | 'model_event_budget_exhausted'
        | 'no_lifecycle_label'
        | 'pull_request'
        | 'terminal_state'
        | 'unsupported_action';
    };

export interface RouteInput {
  actionLogin?: string;
  activationPolicy: 'automatic-public' | 'trusted';
  botLogins?: readonly string[];
  event: ProjectedGitHubEvent;
  ledger: AttemptLedger;
  lifecycleLabels: LifecycleLabels;
  maxModelEvents: number;
  trustedActivation?: boolean;
  trustedReset?: boolean;
}

function isBot(login: string, actionLogin?: string, configured: readonly string[] = []): boolean {
  return login === actionLogin || configured.includes(login);
}

export function evaluateRoute(input: RouteInput): EventRoute {
  const { event, ledger } = input;
  if (ledger.processedEventFingerprints.includes(event.eventFingerprint)) {
    return { kind: 'noop', reason: 'duplicate_event' };
  }
  if (event.isPullRequest) return { kind: 'noop', reason: 'pull_request' };

  if (event.kind === 'issues') {
    if (event.action === 'closed') return { issueNumber: event.issue.number, kind: 'cleanup' };
    if (event.action !== 'opened' && event.action !== 'reopened') {
      return { kind: 'noop', reason: 'unsupported_action' };
    }
    if (input.activationPolicy === 'trusted' && !input.trustedActivation) {
      return { kind: 'noop', reason: 'awaiting_trusted_activation' };
    }
    return {
      eventFingerprint: event.eventFingerprint,
      generation: ledger.generation + 1,
      kind: 'triage',
      resetBudgets: true,
    };
  }

  if (event.action !== 'created') return { kind: 'noop', reason: 'unsupported_action' };
  if (isBot(event.actor.login, input.actionLogin, input.botLogins)) {
    return { kind: 'noop', reason: 'bot_comment' };
  }
  const label = reconcileLifecycleLabels(event.issue.labels, input.lifecycleLabels);
  if (label.kind === 'conflict') return label;
  if (label.kind === 'missing') return { kind: 'noop', reason: 'no_lifecycle_label' };
  if (label.state === 'needs_triage' && input.trustedReset) {
    return {
      eventFingerprint: event.eventFingerprint,
      generation: ledger.generation + 1,
      kind: 'triage',
      resetBudgets: true,
    };
  }
  if (terminalStates.has(label.state)) return { kind: 'noop', reason: 'terminal_state' };
  if (ledger.failureCount >= 3) return { kind: 'noop', reason: 'failure_budget_exhausted' };
  if (ledger.modelEventCount >= input.maxModelEvents) {
    return { kind: 'noop', reason: 'model_event_budget_exhausted' };
  }
  if (label.state === 'fix_pending') {
    return {
      commentId: event.comment.id,
      generation: ledger.generation,
      kind: 'classify_fix_response',
      state: label.state,
    };
  }
  if (!retriableStates.has(label.state)) return { kind: 'noop', reason: 'terminal_state' };
  if (input.activationPolicy === 'trusted' && !input.trustedActivation && !input.trustedReset) {
    return { kind: 'noop', reason: 'awaiting_trusted_activation' };
  }
  return {
    commentId: event.comment.id,
    generation: ledger.generation,
    kind: 'classify_retriage',
    state: label.state,
  };
}
