import type { EvidenceInput } from '../../domain/evidence.js';

export interface EvidenceAdapter {
  source: string;
  collect(sourceIncidentId: string): Promise<EvidenceInput[]>;
}

export async function collectEvidence(
  sourceIncidentId: string,
  adapters: readonly EvidenceAdapter[],
): Promise<{
  items: EvidenceInput[];
  failures: { source: string; reasonCode: 'ADAPTER_UNAVAILABLE' }[];
}> {
  const items: EvidenceInput[] = [];
  const failures: { source: string; reasonCode: 'ADAPTER_UNAVAILABLE' }[] = [];
  for (const adapter of adapters) {
    try {
      items.push(...(await adapter.collect(sourceIncidentId)));
    } catch {
      failures.push({ source: adapter.source, reasonCode: 'ADAPTER_UNAVAILABLE' });
    }
  }
  return { items, failures };
}
