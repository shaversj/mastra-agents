import { appMetadata } from '../src/config/app.js';
import { createDecisionCapsule } from '../src/certification/capsule.js';
import {
  runCapsuleExperiment,
  type MastraDatasetCoordinator,
} from '../src/certification/certification.js';
import { incidentDecisionGateId } from '../src/mastra/scorers/incident-decision-gate.js';

if (process.env.LIVE_MODEL_EXPERIMENTS !== 'true') {
  console.log('Live certification skipped; set LIVE_MODEL_EXPERIMENTS=true to opt in.');
  process.exitCode = 0;
} else {
  const { mastra } = await import('../src/mastra/index.js');
  const capsule = createDecisionCapsule({
    attemptId: '00000000-0000-4000-8000-000000000001',
    normalizedIncident: {
      service: 'checkout-api',
      summary: 'Dependency timeouts correlate with checkout failures',
    },
    manifestId: 'certification-manifest-v1',
    manifestDigest: 'certification-manifest-digest-v1',
    manifestItems: [
      {
        evidenceId: 'ev-certification-1',
        source: 'recorded-metrics',
        sourceTier: 'primary',
        sourceLocator: 'metrics/checkout/dependency-timeouts',
        freshness: 'fresh',
        collectionStatus: 'complete',
      },
    ],
    model: { provider: 'configured', modelId: process.env.MODEL_ID ?? '', settings: {} },
    versions: {
      prompt: 'incident-triage-prompt/v1',
      schema: 'incident-decision/v1',
      policy: 'mitigation-policy/v1',
      catalog: 'mitigation-catalog/v1',
      redaction: 'redaction/v1',
      collector: 'collector/v1',
      applicationBuild: process.env.APP_BUILD_VERSION ?? 'development',
      mastra: '1.74.0',
    },
    structuredResult: {},
    validationOutcomes: {},
    mastraRefs: { workflowRunId: 'certification-source' },
  });
  const result = await runCapsuleExperiment({
    datasets: mastra.datasets as unknown as MastraDatasetCoordinator,
    datasetId: process.env.CERTIFICATION_DATASET_ID ?? 'incident-triage-certification-v1',
    datasetVersion: process.env.CERTIFICATION_DATASET_VERSION ?? 'v1',
    capsules: [capsule],
    workflowId: appMetadata.workflowId,
    scorerId: incidentDecisionGateId,
    candidateBundle: process.env.CANDIDATE_BUNDLE ?? 'local-candidate',
  });
  console.log(JSON.stringify(result));
}
