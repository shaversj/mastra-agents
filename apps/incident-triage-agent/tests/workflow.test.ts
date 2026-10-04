import { Mastra } from '@mastra/core/mastra';
import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { describe, expect, it } from 'vitest';

import { appMetadata, loadAppConfig } from '../src/config/app.js';
import {
  createIncidentTriageAgent,
  type IncidentAgentModel,
} from '../src/mastra/agents/incident-triage.js';
import { createIncidentTriageWorkflow } from '../src/mastra/workflows/incident-triage.js';

const config = loadAppConfig({
  MODEL_ID: 'openai/gpt-4o-mini',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/incident_triage',
  INCIDENT_HMAC_SECRET: 'a-secret-that-is-at-least-thirty-two-characters',
  JWT_ISSUER: 'https://identity.example.com/',
  JWT_AUDIENCE: 'incident-triage-agent',
  JWT_JWKS_URL: 'https://identity.example.com/.well-known/jwks.json',
});

function decision(incidentClass: string, nextAction: string) {
  return {
    incidentClass,
    nextAction,
    evidenceCitations: ['ev-1'],
    confidence: 0.9,
    caveats: [],
    hypotheses: ['Evidence supports the classification'],
    rationale: 'The sealed evidence matches the bounded incident pattern.',
    verificationPlan: ['Verify the observed signal returns to baseline'],
  };
}

async function runWorkflow(output: Record<string, unknown>) {
  const workflow = createIncidentTriageWorkflow();
  const mastra = new Mastra({
    agents: {
      [appMetadata.agentId]: createIncidentTriageAgent(
        config,
        createMockModel({
          objectGenerationMode: 'json',
          mockText: output,
          version: 'v2',
        }) as IncidentAgentModel,
      ),
    },
    workflows: { [appMetadata.workflowId]: workflow },
  });
  const run = await mastra.getWorkflow(appMetadata.workflowId).createRun();
  return run.start({
    inputData: {
      attemptId: 'attempt-1',
      incident: { service: 'checkout-api' },
      manifest: {
        id: 'manifest-1',
        attemptId: 'attempt-1',
        digest: 'digest',
        sealedAt: '2026-10-03T18:00:00.000Z',
        items: [
          {
            evidenceId: 'ev-1',
            source: 'metrics',
            sourceTier: 'primary',
            sourceLocator: 'metrics/api',
            freshness: 'fresh',
            collectionStatus: 'complete',
          },
        ],
      },
    },
  });
}

describe('incident triage Mastra workflow', () => {
  it.each([
    ['dependency_outage', 'escalate_owner', 'completed', false],
    ['bad_deploy', 'rollback_release', 'approval_pending', true],
    ['capacity_saturation', 'scale_service', 'approval_pending', true],
    ['noisy_alert', 'continue_monitoring', 'completed', false],
  ])('maps %s to bounded %s policy', async (incidentClass, action, disposition, approval) => {
    const result = await runWorkflow(decision(incidentClass, action));

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.policy).toMatchObject({
        disposition,
        requiresApproval: approval,
        executed: false,
      });
    }
  });

  it('fails before policy when the model cites unknown evidence', async () => {
    const result = await runWorkflow({
      ...decision('dependency_outage', 'escalate_owner'),
      evidenceCitations: ['ev-invented'],
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed')
      expect(result.error.message).toContain('UNKNOWN_EVIDENCE_CITATION');
  });
});
