import type { Pool } from 'pg';

import { PgEvidenceLedger } from '../evidence/ledger.js';
import { workflowInputSchema } from '../mastra/workflows/incident-triage.js';

export async function loadWorkflowInput(pool: Pool, attemptId: string) {
  const result = await pool.query<{
    source: string;
    delivery_id: string;
    payload: Record<string, unknown>;
    created_at: Date;
    manifest_id: string | null;
    digest: string | null;
    items: unknown;
    sealed_at: Date | null;
  }>(
    `SELECT d.source, d.delivery_id, d.redacted_payload AS payload, d.created_at,
            m.id AS manifest_id, m.digest, m.items, m.sealed_at
     FROM incident_attempts a
     JOIN incident_deliveries d
       ON d.source = a.delivery_source AND d.delivery_id = a.delivery_id
     LEFT JOIN incident_evidence_manifests m ON m.attempt_id = a.id
     WHERE a.id = $1`,
    [attemptId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('ATTEMPT_NOT_FOUND');

  let manifest =
    row.manifest_id && row.digest && row.sealed_at
      ? {
          id: row.manifest_id,
          attemptId,
          digest: row.digest,
          items: row.items,
          sealedAt: row.sealed_at.toISOString(),
        }
      : undefined;
  if (!manifest) {
    const ledger = new PgEvidenceLedger(pool);
    await ledger.record(attemptId, {
      source: row.source,
      sourceTier: 'primary',
      sourceLocator: `delivery/${row.source}/${row.delivery_id}`,
      observedAt: row.created_at.toISOString(),
      collectorVersion: 'collector/v1',
      redactionVersion: 'redaction/v1',
      canonicalizationVersion: 'canonical-json/v1',
      freshness: 'fresh',
      collectionStatus: 'complete',
      normalizedPayload: row.payload,
    });
    manifest = await ledger.seal(attemptId);
  }

  return workflowInputSchema.parse({ attemptId, incident: row.payload, manifest });
}
