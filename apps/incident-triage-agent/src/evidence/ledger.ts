import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type {
  EvidenceContent,
  EvidenceInput,
  EvidenceManifest,
  EvidenceManifestItem,
  EvidenceObservation,
} from '../domain/evidence.js';
import { canonicalize, createEvidenceIdentity, sha256 } from './canonicalize.js';

export class EvidenceLedger {
  private readonly contents = new Map<string, EvidenceContent>();
  private readonly observations: EvidenceObservation[] = [];
  private readonly manifests = new Map<string, EvidenceManifest>();

  record(attemptId: string, input: EvidenceInput): { evidenceId: string; observationId: string } {
    const evidenceId = createEvidenceIdentity(input);
    if (!this.contents.has(evidenceId)) {
      this.contents.set(evidenceId, {
        ...input,
        normalizedPayload: structuredClone(input.normalizedPayload),
        id: evidenceId,
        payloadDigest: sha256(canonicalize(input.normalizedPayload)),
      });
    }
    const observation: EvidenceObservation = {
      id: randomUUID(),
      attemptId,
      evidenceId,
      recordedAt: new Date().toISOString(),
    };
    this.observations.push(observation);
    return { evidenceId, observationId: observation.id };
  }

  seal(attemptId: string, evidenceIds: readonly string[]): EvidenceManifest {
    if (this.manifests.has(attemptId)) throw new Error('MANIFEST_ALREADY_SEALED');
    const unique = [...new Set(evidenceIds)].sort();
    const items = unique.map((id): EvidenceManifestItem => {
      const content = this.contents.get(id);
      if (!content) throw new Error('EVIDENCE_NOT_FOUND');
      const observed = this.observations.some(
        (observation) => observation.attemptId === attemptId && observation.evidenceId === id,
      );
      if (!observed) throw new Error('EVIDENCE_NOT_OBSERVED_FOR_ATTEMPT');
      return {
        evidenceId: id,
        source: content.source,
        sourceTier: content.sourceTier,
        sourceLocator: content.sourceLocator,
        freshness: content.freshness,
        collectionStatus: content.collectionStatus,
      };
    });
    const digest = sha256(canonicalize(items));
    const manifest: EvidenceManifest = Object.freeze({
      id: `manifest_${digest}`,
      attemptId,
      digest,
      items: Object.freeze(items.map((item) => Object.freeze(item))),
      sealedAt: new Date().toISOString(),
    });
    this.manifests.set(attemptId, manifest);
    return manifest;
  }

  provenance(
    manifestId: string,
    citations: readonly string[],
  ): { sources: string[]; sourceTiers: string[]; freshness: string[]; missingContext: string[] } {
    const manifest = [...this.manifests.values()].find((candidate) => candidate.id === manifestId);
    if (!manifest) throw new Error('MANIFEST_NOT_FOUND');
    const cited = new Set(citations);
    for (const citation of cited) {
      if (!manifest.items.some((item) => item.evidenceId === citation))
        throw new Error('UNKNOWN_CITATION');
    }
    const citedItems = manifest.items.filter((item) => cited.has(item.evidenceId));
    return {
      sources: [...new Set(citedItems.map((item) => item.source))].sort(),
      sourceTiers: [...new Set(citedItems.map((item) => item.sourceTier))].sort(),
      freshness: [...new Set(citedItems.map((item) => item.freshness))].sort(),
      missingContext: manifest.items
        .filter((item) => item.collectionStatus !== 'complete')
        .map((item) => item.sourceLocator)
        .sort(),
    };
  }

  getManifest(attemptId: string): EvidenceManifest | undefined {
    return this.manifests.get(attemptId);
  }

  snapshot(): {
    contents: EvidenceContent[];
    observations: EvidenceObservation[];
    manifests: EvidenceManifest[];
  } {
    return {
      contents: [...this.contents.values()],
      observations: [...this.observations],
      manifests: [...this.manifests.values()],
    };
  }
}

export class PgEvidenceLedger {
  constructor(private readonly pool: Pool) {}

  async record(
    attemptId: string,
    input: EvidenceInput,
  ): Promise<{ evidenceId: string; observationId: string }> {
    const evidenceId = createEvidenceIdentity(input);
    const observationId = randomUUID();
    const payloadDigest = sha256(canonicalize(input.normalizedPayload));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO incident_evidence_content
          (id, source, source_tier, source_locator, observed_at, collector_version,
           redaction_version, canonicalization_version, payload_digest, normalized_payload,
           freshness, collection_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING`,
        [
          evidenceId,
          input.source,
          input.sourceTier,
          input.sourceLocator,
          input.observedAt,
          input.collectorVersion,
          input.redactionVersion,
          input.canonicalizationVersion,
          payloadDigest,
          input.normalizedPayload,
          input.freshness,
          input.collectionStatus,
        ],
      );
      await client.query(
        `INSERT INTO incident_evidence_observations (id, attempt_id, evidence_id)
         VALUES ($1, $2, $3)`,
        [observationId, attemptId, evidenceId],
      );
      await client.query('COMMIT');
      return { evidenceId, observationId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async seal(attemptId: string): Promise<EvidenceManifest> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT id FROM incident_evidence_manifests WHERE attempt_id = $1',
        [attemptId],
      );
      if (existing.rowCount) throw new Error('MANIFEST_ALREADY_SEALED');
      const result = await client.query<{
        id: string;
        source: string;
        source_tier: EvidenceManifestItem['sourceTier'];
        source_locator: string;
        freshness: EvidenceManifestItem['freshness'];
        collection_status: EvidenceManifestItem['collectionStatus'];
      }>(
        `SELECT DISTINCT c.id, c.source, c.source_tier, c.source_locator,
                c.freshness, c.collection_status
         FROM incident_evidence_observations o
         JOIN incident_evidence_content c ON c.id = o.evidence_id
         WHERE o.attempt_id = $1 ORDER BY c.id`,
        [attemptId],
      );
      const items: EvidenceManifestItem[] = result.rows.map((row) => ({
        evidenceId: row.id,
        source: row.source,
        sourceTier: row.source_tier,
        sourceLocator: row.source_locator,
        freshness: row.freshness,
        collectionStatus: row.collection_status,
      }));
      const digest = sha256(canonicalize(items));
      const id = `manifest_${digest}`;
      const sealedAt = new Date().toISOString();
      await client.query(
        `INSERT INTO incident_evidence_manifests (id, attempt_id, digest, items, sealed_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, attemptId, digest, JSON.stringify(items), sealedAt],
      );
      await client.query('COMMIT');
      return { id, attemptId, digest, items, sealedAt };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
