import { describe, expect, it } from 'vitest';

import { canonicalize, createEvidenceIdentity } from '../src/evidence/canonicalize.js';
import { EvidenceLedger } from '../src/evidence/ledger.js';

const evidence = {
  source: 'metrics',
  sourceTier: 'primary' as const,
  sourceLocator: 'service/api/error-rate',
  observedAt: '2026-10-03T18:00:00.000Z',
  collectorVersion: 'metrics-fixture/v1',
  redactionVersion: 'redaction/v1',
  canonicalizationVersion: 'canonical-json/v1' as const,
  freshness: 'fresh' as const,
  collectionStatus: 'complete' as const,
  normalizedPayload: { status: 'degraded', value: 0.31, unit: 'ratio' },
};

describe('evidence identity and sealing', () => {
  it('canonicalizes object keys while preserving array order', () => {
    expect(canonicalize({ b: 2, a: { y: [2, 1], x: true } })).toBe(
      '{"a":{"x":true,"y":[2,1]},"b":2}',
    );
  });

  it('keeps identity stable across object key order and changes on bound metadata', () => {
    const reordered = {
      ...evidence,
      normalizedPayload: { unit: 'ratio', value: 0.31, status: 'degraded' },
    };
    expect(createEvidenceIdentity(evidence)).toBe(createEvidenceIdentity(reordered));
    expect(
      createEvidenceIdentity({ ...evidence, collectorVersion: 'metrics-fixture/v2' }),
    ).not.toBe(createEvidenceIdentity(evidence));
  });

  it('deduplicates content but appends attempt observations', () => {
    const ledger = new EvidenceLedger();
    const first = ledger.record('attempt-1', evidence);
    const second = ledger.record('attempt-2', evidence);

    expect(second.evidenceId).toBe(first.evidenceId);
    expect(second.observationId).not.toBe(first.observationId);
    expect(ledger.snapshot().contents).toHaveLength(1);
    expect(ledger.snapshot().observations).toHaveLength(2);
  });

  it('seals deterministic manifests independent of collection order', () => {
    const ledger = new EvidenceLedger();
    const one = ledger.record('attempt-1', evidence);
    const two = ledger.record('attempt-1', {
      ...evidence,
      source: 'deployments',
      sourceLocator: 'service/api/deploy/latest',
      normalizedPayload: { status: 'succeeded', version: 'api-2026.10.03' },
    });
    const manifest = ledger.seal('attempt-1', [two.evidenceId, one.evidenceId]);

    const another = new EvidenceLedger();
    const reverseTwo = another.record('attempt-2', {
      ...evidence,
      source: 'deployments',
      sourceLocator: 'service/api/deploy/latest',
      normalizedPayload: { version: 'api-2026.10.03', status: 'succeeded' },
    });
    const reverseOne = another.record('attempt-2', evidence);
    const reverseManifest = another.seal('attempt-2', [
      reverseOne.evidenceId,
      reverseTwo.evidenceId,
    ]);

    expect(reverseManifest.digest).toBe(manifest.digest);
    expect(() => ledger.seal('attempt-1', [one.evidenceId])).toThrow('MANIFEST_ALREADY_SEALED');
  });

  it.each([
    { ...evidence, normalizedPayload: { token: 'credential' } },
    { ...evidence, normalizedPayload: { value: Number.POSITIVE_INFINITY } },
    { ...evidence, canonicalizationVersion: 'v2' },
    { ...evidence, normalizedPayload: { unexpected: 'field' } },
  ])('rejects unsafe or unstable evidence before persistence', (input) => {
    const ledger = new EvidenceLedger();
    expect(() => ledger.record('attempt', input as typeof evidence)).toThrow();
    expect(ledger.snapshot().contents).toHaveLength(0);
  });

  it('derives provenance from only cited manifest items', () => {
    const ledger = new EvidenceLedger();
    const item = ledger.record('attempt', evidence);
    const missing = ledger.record('attempt', {
      ...evidence,
      source: 'logs',
      sourceTier: 'secondary',
      sourceLocator: 'service/api/logs',
      freshness: 'stale',
      collectionStatus: 'partial',
      normalizedPayload: { message: 'log adapter unavailable', status: 'partial' },
    });
    const manifest = ledger.seal('attempt', [item.evidenceId, missing.evidenceId]);

    expect(ledger.provenance(manifest.id, [item.evidenceId])).toEqual({
      sources: ['metrics'],
      sourceTiers: ['primary'],
      freshness: ['fresh'],
      missingContext: ['service/api/logs'],
    });
  });
});
