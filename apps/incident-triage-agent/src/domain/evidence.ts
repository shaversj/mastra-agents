export type SourceTier = 'primary' | 'secondary' | 'context';
export type EvidenceFreshness = 'fresh' | 'stale' | 'unknown';
export type CollectionStatus = 'complete' | 'partial';

export interface EvidenceInput {
  source: string;
  sourceTier: SourceTier;
  sourceLocator: string;
  observedAt: string;
  collectorVersion: string;
  redactionVersion: string;
  canonicalizationVersion: 'canonical-json/v1';
  freshness: EvidenceFreshness;
  collectionStatus: CollectionStatus;
  normalizedPayload: Record<string, unknown>;
}

export interface EvidenceContent extends EvidenceInput {
  id: string;
  payloadDigest: string;
}

export interface EvidenceObservation {
  id: string;
  attemptId: string;
  evidenceId: string;
  recordedAt: string;
}

export interface EvidenceManifestItem {
  evidenceId: string;
  source: string;
  sourceTier: SourceTier;
  sourceLocator: string;
  freshness: EvidenceFreshness;
  collectionStatus: CollectionStatus;
}

export interface EvidenceManifest {
  id: string;
  attemptId: string;
  digest: string;
  items: readonly EvidenceManifestItem[];
  sealedAt: string;
}
