import { Mastra } from '@mastra/core/mastra';

import { appMetadata, loadAppConfig } from '../config/app.js';
import { createWriterAgent } from './agents/writer.js';

const config = loadAppConfig();
const writerAgent = createWriterAgent(config);

export const mastra = new Mastra({
  agents: {
    [appMetadata.agentId]: writerAgent,
  },
  server: {
    host: config.host,
    port: config.port,
  },
});
