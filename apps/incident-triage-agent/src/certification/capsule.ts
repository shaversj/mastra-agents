import { canonicalize, sha256 } from '../evidence/canonicalize.js';

export interface DecisionCapsuleInput {
  attemptId: string;
  normalizedIncident: Record<string, unknown>;
  manifestId: string;
  manifestDigest: string;
  manifestItems: Record<string, unknown>[];
  model: { provider: string; modelId: string; settings: Record<string, unknown> };
  versions: {
    prompt: string;
    schema: string;
    policy: string;
    catalog: string;
    redaction: string;
    collector: string;
    applicationBuild: string;
    mastra: string;
  };
  structuredResult: Record<string, unknown>;
  validationOutcomes: Record<string, boolean>;
  mastraRefs: { workflowRunId: string; traceId?: string; gateResultId?: string };
}

export interface DecisionCapsule extends DecisionCapsuleInput {
  id: string;
  createdAt: string;
  retentionClass: 'governance';
}

export function createDecisionCapsule(
  input: DecisionCapsuleInput,
  now = new Date(),
): DecisionCapsule {
  const id = `capsule_${sha256(canonicalize(input))}`;
  return {
    ...structuredClone(input),
    id,
    createdAt: now.toISOString(),
    retentionClass: 'governance',
  };
}
