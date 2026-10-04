import { createMockModel } from '@mastra/core/test-utils/llm-mock';

import type { IncidentAgentModel } from '../agents/incident-triage.js';

export function createFixtureIncidentModel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): IncidentAgentModel {
  if (environment.INCIDENT_FIXTURE_MODEL_ENABLED !== 'true') {
    throw new Error('Fixture model requires INCIDENT_FIXTURE_MODEL_ENABLED=true');
  }
  const evidenceId = environment.INCIDENT_FIXTURE_EVIDENCE_ID?.trim();
  if (!evidenceId) throw new Error('INCIDENT_FIXTURE_EVIDENCE_ID is required for fixture model');
  return createMockModel({
    objectGenerationMode: 'json',
    mockText: {
      incidentClass: 'dependency_outage',
      nextAction: 'escalate_owner',
      evidenceCitations: [evidenceId],
      confidence: 0.9,
      caveats: [],
      hypotheses: ['The recorded fixture evidence indicates a dependency outage.'],
      rationale: 'The sealed fixture evidence supports bounded owner escalation.',
      verificationPlan: ['Verify the dependency signal returns to baseline.'],
    },
    version: 'v2',
  }) as IncidentAgentModel;
}
