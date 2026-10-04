import type { TriageDecision } from '../domain/decision.js';
import { decisionSchema } from '../domain/decision.js';
import type { EvidenceManifest } from '../domain/evidence.js';

export function validateDecision(candidate: unknown, manifest: EvidenceManifest): TriageDecision {
  const decision = decisionSchema.parse(candidate);
  const known = new Set(manifest.items.map((item) => item.evidenceId));
  if (decision.evidenceCitations.some((citation) => !known.has(citation))) {
    throw new Error('UNKNOWN_EVIDENCE_CITATION');
  }
  return decision;
}
