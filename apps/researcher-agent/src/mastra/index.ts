import { Mastra } from '@mastra/core/mastra';

import { appMetadata, loadAppConfig } from '../config/app.js';
import { createResearcherAgent } from './agents/researcher.js';

const config = loadAppConfig();
const researcherAgent = createResearcherAgent(config);

export const mastra = new Mastra({
  agents: {
    [appMetadata.agentId]: researcherAgent,
  },
  server: {
    host: config.host,
    port: config.port,
  },
});
