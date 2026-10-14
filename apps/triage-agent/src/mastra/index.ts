import { Mastra } from '@mastra/core/mastra';

import { appMetadata } from '../config/app.js';
import type { HistoryAdapter } from '../git/history.js';
import {
  createTriageCodingAgent,
  type TriageAgentModel,
  type TriageCodingAgentFactory,
} from './agents/triage.js';
import {
  createTriageCommentWorkflow,
  type TriageCommentWorkflowOptions,
} from './workflows/triage-comment.js';
import {
  createTriageWorkflow,
  invokeRegisteredTriageAgent,
  type ModelInvoker,
  type TriageWorkflowOptions,
} from './workflows/triage.js';
import { triageReleaseGate, triageReleaseGateId } from './scorers/triage-release-gate.js';

export { redactedTracingOptions } from './workflows/triage.js';
export const invokeRedactedTriageAgent = invokeRegisteredTriageAgent;

interface TriageMastraConfiguration {
  agents: Record<string, unknown>;
  logger: false;
  loggerOptions: { correlation: false; export: false };
  scorers: Record<string, unknown>;
  workflows: Record<string, unknown>;
}

type TriageMastraFactory<TResult> = (configuration: TriageMastraConfiguration) => TResult;

const defaultMastraFactory: TriageMastraFactory<Mastra> = (configuration) =>
  new Mastra(configuration as ConstructorParameters<typeof Mastra>[0]);

export interface CreateTriageMastraOptions<
  TAgent = ReturnType<typeof createTriageCodingAgent>,
  TMastra = Mastra,
> {
  admitChanges?: TriageWorkflowOptions['admitChanges'];
  collectEvidence?: TriageWorkflowOptions['collectEvidence'];
  createAgent?: TriageCodingAgentFactory<TAgent>;
  createMastra?: TriageMastraFactory<TMastra>;
  history: HistoryAdapter;
  invokeModel?: ModelInvoker;
  model: TriageAgentModel;
  prSkill?: TriageCommentWorkflowOptions['prSkill'];
  workspace: unknown;
  verificationModel?: TriageAgentModel;
}

export function createTriageMastra<TAgent, TMastra = Mastra>(
  options: CreateTriageMastraOptions<TAgent, TMastra>,
): TMastra {
  const agent = createTriageCodingAgent({
    ...(options.createAgent ? { createAgent: options.createAgent } : {}),
    history: options.history,
    model: options.model,
    workspace: options.workspace,
  });
  const invokeModel =
    options.invokeModel ??
    ((request, runtime) =>
      invokeRedactedTriageAgent(
        options.verificationModel && request.activeTools?.length === 0
          ? { ...request, model: options.verificationModel }
          : request,
        runtime,
      ));
  const triageWorkflow = createTriageWorkflow({
    ...(options.admitChanges ? { admitChanges: options.admitChanges } : {}),
    ...(options.collectEvidence ? { collectEvidence: options.collectEvidence } : {}),
    invokeModel,
    ...(options.prSkill ? { prSkill: options.prSkill } : {}),
  });
  const commentWorkflow = createTriageCommentWorkflow({
    invokeModel,
    ...(options.prSkill ? { prSkill: options.prSkill } : {}),
  });

  const createMastra =
    options.createMastra ?? (defaultMastraFactory as unknown as TriageMastraFactory<TMastra>);
  return createMastra({
    agents: { [appMetadata.agentId]: agent as never },
    logger: false,
    loggerOptions: { correlation: false, export: false },
    scorers: { [triageReleaseGateId]: triageReleaseGate },
    workflows: {
      [appMetadata.workflowIds.comment]: commentWorkflow,
      [appMetadata.workflowIds.triage]: triageWorkflow,
    },
  });
}
