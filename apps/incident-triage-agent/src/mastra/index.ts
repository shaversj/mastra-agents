import { Mastra } from '@mastra/core/mastra';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';

import { appMetadata, loadAppConfig } from '../config/app.js';
import { createCaseRoutes } from '../http/routes/cases.js';
import { createIntakeRoute } from '../http/routes/intake.js';
import { createOperationalRoutes } from '../http/routes/readiness.js';
import { createDatabasePool } from '../persistence/db.js';
import { PgCaseRepository } from '../persistence/repositories/case-repository.js';
import { createJwtAuthProvider } from '../security/auth.js';
import { createIncidentTriageAgent } from './agents/incident-triage.js';
import { incidentTriageWorkflow } from './workflows/incident-triage.js';

const config = loadAppConfig();
const pool = createDatabasePool(config);
const caseRepository = new PgCaseRepository(pool);
const storage = new PostgresStore({
  id: 'incident-mastra-storage',
  connectionString: config.databaseUrl,
  schemaName: 'mastra_incident_triage',
});

export const mastra = new Mastra({
  agents: {
    [appMetadata.agentId]: createIncidentTriageAgent(config),
  },
  workflows: {
    [appMetadata.workflowId]: incidentTriageWorkflow,
  },
  storage,
  observability: new Observability({
    configs: {
      incident: {
        serviceName: appMetadata.appId,
        exporters: [new MastraStorageExporter()],
        spanOutputProcessors: [new SensitiveDataFilter({ redactionStyle: 'full' })],
        includeInternalSpans: false,
        requestContextKeys: ['correlationId'],
        serializationOptions: { maxStringLength: 4000, maxDepth: 6, maxArrayLength: 100 },
      },
    },
  }),
  server: {
    auth: createJwtAuthProvider(config),
    apiRoutes: [
      createIntakeRoute(config, caseRepository),
      ...createCaseRoutes(config, pool),
      ...createOperationalRoutes(pool),
    ],
    host: config.host,
    port: config.port,
    drainTimeout: 10_000,
  },
});
