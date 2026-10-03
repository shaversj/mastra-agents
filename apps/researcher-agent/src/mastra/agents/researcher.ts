import { Agent } from '@mastra/core/agent';

import { appMetadata, type AppConfig } from '../../config/app.js';

export function createResearcherAgent(config: AppConfig): Agent {
  return new Agent({
    id: appMetadata.agentId,
    name: 'Researcher Agent',
    instructions:
      'Research the requested subject carefully, distinguish evidence from inference, and cite the sources used.',
    model: config.modelId,
  });
}
