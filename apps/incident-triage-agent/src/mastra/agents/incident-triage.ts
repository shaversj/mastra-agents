import { Agent } from '@mastra/core/agent';

import { appMetadata, type AppConfig } from '../../config/app.js';

export function createIncidentTriageAgent(config: AppConfig): Agent {
  return new Agent({
    id: appMetadata.agentId,
    name: 'Incident Triage Agent',
    instructions:
      'Assess only the sealed incident evidence supplied by the workflow. Cite evidence IDs, stay within the response schema, and never claim to execute a production action.',
    model: config.modelId,
  });
}
