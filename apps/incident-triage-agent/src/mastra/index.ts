import { Mastra } from '@mastra/core/mastra';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';

import { appMetadata, loadAppConfig } from '../config/app.js';
import { createPermit } from '../approvals/permit.js';
import { canonicalize, sha256 } from '../evidence/canonicalize.js';
import { createCaseRoutes } from '../http/routes/cases.js';
import { createApprovalRoute } from '../http/routes/approvals.js';
import { createIntakeRoute } from '../http/routes/intake.js';
import { createOperationalRoutes } from '../http/routes/readiness.js';
import { createDatabasePool } from '../persistence/db.js';
import { PgApprovalRepository } from '../persistence/repositories/approval-repository.js';
import { PgCaseRepository } from '../persistence/repositories/case-repository.js';
import { createJwtAuthProvider } from '../security/auth.js';
import { createIncidentTriageAgent } from './agents/incident-triage.js';
import { createIncidentTriageWorkflow } from './workflows/incident-triage.js';

const config = loadAppConfig();
const pool = createDatabasePool(config);
const caseRepository = new PgCaseRepository(pool);
const approvalRepository = new PgApprovalRepository(pool);
const storage = new PostgresStore({
  id: 'incident-mastra-storage',
  connectionString: config.databaseUrl,
  schemaName: 'mastra_incident_triage',
});
const incidentTriageWorkflow = createIncidentTriageWorkflow({
  createApprovalPermit: async ({ runId, stepId, value }) => {
    const attempt = await caseRepository.getAttempt(value.attemptId);
    if (!attempt || attempt.mastraRunId !== runId) throw new Error('WORKFLOW_RUN_BINDING_MISMATCH');
    const permit = createPermit({
      binding: {
        caseId: attempt.caseId,
        attemptId: attempt.id,
        mastraRunId: runId,
        suspendedStep: stepId,
        manifestDigest: value.manifestDigest,
        decisionDigest: sha256(canonicalize(value.decision)),
        stagedParametersDigest: sha256(
          canonicalize({ action: value.policy.catalogAction, executed: false }),
        ),
        verificationPlanDigest: sha256(canonicalize(value.decision.verificationPlan)),
        buildVersion: process.env.APP_BUILD_VERSION?.trim() || 'development',
        promptVersion: 'incident-triage-prompt/v1',
        schemaVersion: 'incident-decision/v1',
        policyVersion: 'mitigation-policy/v1',
        catalogVersion: 'mitigation-catalog/v1',
        collectorVersion: 'collector/v1',
        redactionVersion: 'redaction/v1',
      },
      eligibleRoles: [config.approverRole],
      expiresAt: new Date(Date.now() + config.approvalTtlSeconds * 1000),
    });
    await approvalRepository.insert(permit);
    return permit.id;
  },
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
      createApprovalRoute(config, approvalRepository),
      ...createOperationalRoutes(pool),
    ],
    host: config.host,
    port: config.port,
    drainTimeout: 10_000,
  },
});
