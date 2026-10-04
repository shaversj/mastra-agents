import { Mastra } from '@mastra/core/mastra';
import { PostgresStore } from '@mastra/pg';

import { appMetadata, loadAppConfig } from '../config/app.js';
import { createJwtAuthProvider } from '../security/auth.js';
import { createIncidentTriageAgent } from './agents/incident-triage.js';
import { incidentTriageWorkflow } from './workflows/incident-triage.js';

const config = loadAppConfig();

export const mastra = new Mastra({
  agents: {
    [appMetadata.agentId]: createIncidentTriageAgent(config),
  },
  workflows: {
    [appMetadata.workflowId]: incidentTriageWorkflow,
  },
  storage: new PostgresStore({
    id: 'incident-mastra-storage',
    connectionString: config.databaseUrl,
    schemaName: 'mastra_incident_triage',
  }),
  server: {
    auth: createJwtAuthProvider(config),
    host: config.host,
    port: config.port,
    drainTimeout: 10_000,
  },
});
