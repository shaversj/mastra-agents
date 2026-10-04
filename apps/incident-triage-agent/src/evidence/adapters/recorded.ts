import type { EvidenceInput } from '../../domain/evidence.js';
import type { EvidenceAdapter } from './types.js';

export class RecordedEvidenceAdapter implements EvidenceAdapter {
  constructor(
    readonly source: string,
    private readonly recordings: Readonly<Record<string, readonly EvidenceInput[]>>,
  ) {}

  async collect(sourceIncidentId: string): Promise<EvidenceInput[]> {
    return [...structuredClone(this.recordings[sourceIncidentId] ?? [])];
  }
}
