import type { EvidenceInput, SourceTier } from '../../domain/evidence.js';
import type { EvidenceAdapter } from './types.js';

interface FixtureItem {
  sourceLocator: string;
  observedAt: string;
  normalizedPayload: Record<string, unknown>;
}

export class FixtureEvidenceAdapter implements EvidenceAdapter {
  constructor(
    readonly source: string,
    private readonly fixtures: Readonly<Record<string, readonly FixtureItem[]>>,
    private readonly sourceTier: SourceTier = 'primary',
  ) {}

  async collect(sourceIncidentId: string): Promise<EvidenceInput[]> {
    return (this.fixtures[sourceIncidentId] ?? []).map((item) => ({
      source: this.source,
      sourceTier: this.sourceTier,
      sourceLocator: item.sourceLocator,
      observedAt: item.observedAt,
      collectorVersion: `fixture-${this.source}/v1`,
      redactionVersion: 'redaction/v1',
      canonicalizationVersion: 'canonical-json/v1',
      freshness: 'fresh',
      collectionStatus: 'complete',
      normalizedPayload: structuredClone(item.normalizedPayload),
    }));
  }
}
