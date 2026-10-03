import { Agent } from '@mastra/core/agent';

import { appMetadata, type AppConfig } from '../../config/app.js';

export function createWriterAgent(config: AppConfig): Agent {
  return new Agent({
    id: appMetadata.agentId,
    name: 'Writer Agent',
    instructions:
      'Write clear, well-structured content for the requested audience, preserving supplied facts and calling out unsupported claims.',
    model: config.modelId,
  });
}
