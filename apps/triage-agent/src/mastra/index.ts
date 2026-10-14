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
  type ModelInvoker,
  type TriageWorkflowOptions,
} from './workflows/triage.js';

export interface CreateTriageMastraOptions<TAgent = ReturnType<typeof createTriageCodingAgent>> {
  collectEvidence?: TriageWorkflowOptions['collectEvidence'];
  createAgent?: TriageCodingAgentFactory<TAgent>;
  history: HistoryAdapter;
  invokeModel?: ModelInvoker;
  model: TriageAgentModel;
  prSkill?: TriageCommentWorkflowOptions['prSkill'];
  workspace: unknown;
}

export function createTriageMastra<TAgent>(options: CreateTriageMastraOptions<TAgent>): Mastra {
  const agent = createTriageCodingAgent({
    ...(options.createAgent ? { createAgent: options.createAgent } : {}),
    history: options.history,
    model: options.model,
    workspace: options.workspace,
  });
  const triageWorkflow = createTriageWorkflow({
    ...(options.collectEvidence ? { collectEvidence: options.collectEvidence } : {}),
    ...(options.invokeModel ? { invokeModel: options.invokeModel } : {}),
  });
  const commentWorkflow = createTriageCommentWorkflow({
    ...(options.invokeModel ? { invokeModel: options.invokeModel } : {}),
    ...(options.prSkill ? { prSkill: options.prSkill } : {}),
  });

  return new Mastra({
    agents: { [appMetadata.agentId]: agent as never },
    workflows: {
      [appMetadata.workflowIds.comment]: commentWorkflow,
      [appMetadata.workflowIds.triage]: triageWorkflow,
    },
  });
}
