import { createHash } from 'node:crypto';

import type { ActionInputs } from './inputs.js';
import { preflightAction, preflightRoute, type PreflightContext } from './preflight.js';
import { appMetadata } from '../config/app.js';
import { projectGitHubEvent, type ProjectedGitHubEvent } from '../domain/event-projection.js';
import {
  evaluateRoute,
  lifecycleStates,
  type AttemptLedger,
  type EventRoute,
  type LifecycleLabels,
  type LifecycleState,
} from '../domain/lifecycle.js';

export interface ActionRequest {
  abortSignal?: AbortSignal;
  deliveryId: string;
  eventName: 'issue_comment' | 'issues';
  payload: unknown;
  runUrl?: string;
  workflowRunId: number;
  workflowRunAttempt?: number;
}

export interface RoutingSnapshot {
  actionLogin?: string;
  activationPolicy: 'automatic-public' | 'trusted';
  botLogins: readonly string[];
  branchProvenanceVerified: boolean;
  githubIdentityVerified: boolean;
  ledger: AttemptLedger;
  lifecycleLabels: LifecycleLabels;
  maxModelEvents: number;
  recovery?: Extract<EventRoute, { kind: 'recover' }>;
  trustedActivation?: boolean;
  trustedReset?: boolean;
}

export interface ActionLease {
  assertCurrent(): Promise<void>;
  fencingToken: string;
  release(): Promise<void>;
}

export interface ModelRuntime {
  close(): Promise<void>;
  mastra?: unknown;
  workspace?: unknown;
}

export interface ActionExecution {
  branch?: string;
  headSha?: string;
  previewUrls?: readonly string[];
  reasonCode: string;
  state?: LifecycleState;
}

type ModelEventRoute = Extract<
  EventRoute,
  { kind: 'classify_fix_response' | 'classify_retriage' | 'triage' }
>;

export interface ActionResult {
  appId: typeof appMetadata.appId;
  branch?: string;
  generation?: number;
  headSha?: string;
  issueNumber: number;
  prUrl?: string;
  previewUrls?: readonly string[];
  reasonCode: string;
  repository: string;
  route: EventRoute['kind'];
  runUrl?: string;
  state?: LifecycleState;
  status: 'completed' | 'noop';
}

export interface ActionObservation {
  attributes: Readonly<Record<string, boolean | number | string>>;
  name: 'triage.outcome' | 'triage.route';
}

export interface SafeActionObserver {
  record(observation: ActionObservation): void;
}

export interface ActionControllerDependencies {
  acquireLease(input: {
    abortSignal?: AbortSignal;
    event: ProjectedGitHubEvent;
    route: Exclude<EventRoute, { kind: 'noop' }>;
    workflowRunId: number;
    workflowRunAttempt: number;
  }): Promise<ActionLease>;
  createModelRuntime(input: {
    abortSignal?: AbortSignal;
    event: ProjectedGitHubEvent;
    inputs: ActionInputs;
    route: Extract<EventRoute, { kind: 'classify_fix_response' | 'classify_retriage' | 'triage' }>;
  }): Promise<ModelRuntime>;
  executeRoute(input: {
    abortSignal?: AbortSignal;
    event: ProjectedGitHubEvent;
    inputs?: ActionInputs;
    lease: ActionLease;
    route: Exclude<EventRoute, { kind: 'noop' }>;
    runtime?: ModelRuntime;
  }): Promise<ActionExecution>;
  inspectModelCapabilities(input: {
    abortSignal?: AbortSignal;
    event: ProjectedGitHubEvent;
    inputs: ActionInputs;
    route: Extract<EventRoute, { kind: 'classify_fix_response' | 'classify_retriage' | 'triage' }>;
  }): Promise<
    Pick<
      PreflightContext,
      | 'checkoutSafe'
      | 'labelsPresent'
      | 'prSkillPresent'
      | 'sandboxAvailable'
      | 'triageSkillPresent'
    >
  >;
  loadModelInputs(abortSignal?: AbortSignal): Promise<ActionInputs>;
  observer?: SafeActionObserver;
  readRoutingState(
    event: ProjectedGitHubEvent,
    abortSignal?: AbortSignal,
  ): Promise<RoutingSnapshot>;
  reconcileFailure(input: {
    event: ProjectedGitHubEvent;
    lease: ActionLease;
    reasonCode: string;
    route: ModelEventRoute;
  }): Promise<void>;
  reconcile(input: {
    abortSignal?: AbortSignal;
    event: ProjectedGitHubEvent;
    execution: ActionExecution;
    inputs?: ActionInputs;
    lease: ActionLease;
    route: Exclude<EventRoute, { kind: 'noop' }>;
    runtime?: ModelRuntime;
  }): Promise<ActionResult>;
}

const safeAttributeNames = new Set([
  'eventHash',
  'generation',
  'issueNumber',
  'reasonCode',
  'repositoryId',
  'route',
  'state',
  'status',
  'workflowRunId',
]);
const safeString = /^[A-Za-z0-9_.:/-]{1,200}$/u;
const safeReasonCode = /^[A-Z0-9_]{1,100}$/u;
const safeBranch = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9._/-]{1,255}$/u;

function boundedObservation(observation: ActionObservation): ActionObservation {
  const attributes: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(observation.attributes)) {
    if (!safeAttributeNames.has(key)) continue;
    if (typeof value === 'string' && !safeString.test(value)) continue;
    if (typeof value === 'number' && !Number.isSafeInteger(value)) continue;
    attributes[key] = value;
  }
  return { attributes, name: observation.name };
}

export function createSafeActionObserver(
  sink: (observation: ActionObservation) => void,
): SafeActionObserver {
  return {
    record(observation) {
      sink(boundedObservation(observation));
    },
  };
}

export function isSafeReasonCode(value: string): boolean {
  return safeReasonCode.test(value);
}

function eventHash(event: ProjectedGitHubEvent): string {
  return createHash('sha256').update(event.eventFingerprint).digest('hex').slice(0, 16);
}

function generation(route: EventRoute): number | undefined {
  return 'generation' in route ? route.generation : undefined;
}

function observeRoute(
  observer: SafeActionObserver | undefined,
  event: ProjectedGitHubEvent,
  route: EventRoute,
  workflowRunId: number,
): void {
  const routeGeneration = generation(route);
  observer?.record({
    attributes: {
      eventHash: eventHash(event),
      ...(routeGeneration === undefined ? {} : { generation: routeGeneration }),
      issueNumber: event.issue.number,
      repositoryId: event.repository.id,
      route: route.kind,
      workflowRunId,
    },
    name: 'triage.route',
  });
}

function observeOutcome(observer: SafeActionObserver | undefined, result: ActionResult): void {
  observer?.record({
    attributes: {
      ...(result.generation === undefined ? {} : { generation: result.generation }),
      issueNumber: result.issueNumber,
      reasonCode: result.reasonCode,
      route: result.route,
      ...(result.state ? { state: result.state } : {}),
      status: result.status,
    },
    name: 'triage.outcome',
  });
}

function noopResult(event: ProjectedGitHubEvent, route: Extract<EventRoute, { kind: 'noop' }>) {
  return {
    appId: appMetadata.appId,
    issueNumber: event.issue.number,
    reasonCode: route.reason,
    repository: event.repository.fullName,
    route: route.kind,
    status: 'noop',
  } satisfies ActionResult;
}

function isModelRoute(route: EventRoute): route is ModelEventRoute {
  return (
    route.kind === 'triage' ||
    route.kind === 'classify_retriage' ||
    route.kind === 'classify_fix_response'
  );
}

function unexpectedFailureReason(error: unknown): string {
  return error instanceof Error && isSafeReasonCode(error.message)
    ? error.message
    : 'ACTION_FAILED';
}

function assertSafeUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ACTION_RESULT_URL_INVALID');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    value.length > 2_048
  ) {
    throw new Error('ACTION_RESULT_URL_INVALID');
  }
}

function validateReconciledResult(
  result: ActionResult,
  event: ProjectedGitHubEvent,
  route: Exclude<EventRoute, { kind: 'noop' }>,
): ActionResult {
  if (
    result.appId !== appMetadata.appId ||
    result.status !== 'completed' ||
    result.route !== route.kind ||
    result.issueNumber !== event.issue.number ||
    result.repository !== event.repository.fullName ||
    !isSafeReasonCode(result.reasonCode) ||
    (result.state !== undefined && !lifecycleStates.includes(result.state)) ||
    (result.branch !== undefined && !safeBranch.test(result.branch)) ||
    (result.headSha !== undefined && !/^[a-f0-9]{40,64}$/u.test(result.headSha))
  ) {
    throw new Error('ACTION_RESULT_INVALID');
  }
  if (result.prUrl) assertSafeUrl(result.prUrl);
  for (const url of result.previewUrls ?? []) assertSafeUrl(url);
  return result;
}

async function cleanupResources(
  runtime: ModelRuntime | undefined,
  lease: ActionLease | undefined,
): Promise<void> {
  let failure: unknown;
  if (runtime) {
    try {
      await runtime.close();
    } catch (error) {
      failure = error;
    }
  }
  if (lease) {
    try {
      await lease.release();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
  }
  if (failure !== undefined) throw new Error('ACTION_RESOURCE_CLEANUP_FAILED', { cause: failure });
}

export async function runTriageAction(
  request: ActionRequest,
  dependencies: ActionControllerDependencies,
): Promise<ActionResult> {
  request.abortSignal?.throwIfAborted();
  const event = projectGitHubEvent(request.eventName, request.payload, request.deliveryId);
  const routing = await dependencies.readRoutingState(event, request.abortSignal);
  request.abortSignal?.throwIfAborted();
  const route =
    routing.recovery ??
    evaluateRoute({
      ...(routing.actionLogin ? { actionLogin: routing.actionLogin } : {}),
      activationPolicy: routing.activationPolicy,
      botLogins: routing.botLogins,
      event,
      ledger: routing.ledger,
      lifecycleLabels: routing.lifecycleLabels,
      maxModelEvents: routing.maxModelEvents,
      ...(routing.trustedActivation === undefined
        ? {}
        : { trustedActivation: routing.trustedActivation }),
      ...(routing.trustedReset === undefined ? {} : { trustedReset: routing.trustedReset }),
    });
  observeRoute(dependencies.observer, event, route, request.workflowRunId);

  if (route.kind === 'noop') {
    const result = noopResult(event, route);
    observeOutcome(dependencies.observer, result);
    return result;
  }

  let inputs: ActionInputs | undefined;
  let lease: ActionLease | undefined;
  let runtime: ModelRuntime | undefined;
  let startedModelRoute: ModelEventRoute | undefined;
  let result: ActionResult | undefined;
  let primaryError: unknown;
  try {
    if (route.kind === 'cleanup') {
      preflightRoute({
        branchProvenanceVerified: routing.branchProvenanceVerified,
        githubIdentityVerified: routing.githubIdentityVerified,
        repositoryVisibility: event.repository.visibility,
        route: 'cleanup',
      });
    } else if (route.kind === 'conflict' || route.kind === 'recover') {
      preflightRoute({
        githubIdentityVerified: routing.githubIdentityVerified,
        repositoryVisibility: event.repository.visibility,
        route: 'conflict',
      });
    } else {
      preflightRoute({ repositoryVisibility: event.repository.visibility, route: 'model' });
      inputs = await dependencies.loadModelInputs(request.abortSignal);
      const capabilities = await dependencies.inspectModelCapabilities({
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        event,
        inputs,
        route,
      });
      preflightAction(inputs, {
        ...capabilities,
        prSkillRequired: route.kind === 'classify_fix_response' || inputs.autoPrOnFix,
        repositoryVisibility: event.repository.visibility,
        route: 'model',
      });
    }
    request.abortSignal?.throwIfAborted();
    lease = await dependencies.acquireLease({
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      event,
      route,
      workflowRunId: request.workflowRunId,
      workflowRunAttempt: request.workflowRunAttempt ?? 1,
    });
    request.abortSignal?.throwIfAborted();
    if (isModelRoute(route)) {
      if (!inputs) throw new Error('MODEL_ROUTE_INPUTS_MISSING');
      runtime = await dependencies.createModelRuntime({
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        event,
        inputs,
        route,
      });
    }
    request.abortSignal?.throwIfAborted();
    if (isModelRoute(route)) {
      if (!inputs || !runtime) throw new Error('MODEL_ROUTE_RUNTIME_MISSING');
      startedModelRoute = route;
    }
    const execution = await dependencies.executeRoute({
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      event,
      ...(inputs ? { inputs } : {}),
      lease,
      route,
      ...(runtime ? { runtime } : {}),
    });
    request.abortSignal?.throwIfAborted();
    result = validateReconciledResult(
      await dependencies.reconcile({
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        event,
        execution,
        ...(inputs ? { inputs } : {}),
        lease,
        route,
        ...(runtime ? { runtime } : {}),
      }),
      event,
      route,
    );
    const routeGeneration = generation(route);
    result = {
      ...result,
      ...(routeGeneration === undefined ? {} : { generation: routeGeneration }),
      ...(request.runUrl ? { runUrl: request.runUrl } : {}),
    };
  } catch (error) {
    primaryError = error;
    if (lease && startedModelRoute) {
      try {
        await dependencies.reconcileFailure({
          event,
          lease,
          reasonCode: unexpectedFailureReason(error),
          route: startedModelRoute,
        });
      } catch {
        // Failure reconciliation is best-effort and must not hide the triggering error.
      }
    }
  } finally {
    try {
      await cleanupResources(runtime, lease);
    } catch (cleanupError) {
      if (primaryError === undefined) primaryError = cleanupError;
    }
  }

  if (primaryError !== undefined) throw primaryError;
  if (!result) throw new Error('ACTION_RESULT_MISSING');
  observeOutcome(dependencies.observer, result);
  return result;
}
