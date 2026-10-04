import { createHash } from 'node:crypto';

import type { EvidenceInput } from '../domain/evidence.js';

const allowedPayloadFields = new Set([
  'summary',
  'status',
  'value',
  'unit',
  'labels',
  'message',
  'eventType',
  'service',
  'region',
  'version',
  'startedAt',
  'endedAt',
]);
const forbiddenKey = /(authorization|cookie|credential|password|secret|token|api.?key)/iu;

function normalized(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('NON_FINITE_EVIDENCE_VALUE');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('UNSTABLE_EVIDENCE_VALUE');
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalized(entry)]),
  );
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(normalized(value));
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validatePayload(payload: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(payload)) {
    if (forbiddenKey.test(key)) throw new Error('FORBIDDEN_EVIDENCE_FIELD');
    if (!allowedPayloadFields.has(key)) throw new Error('UNKNOWN_EVIDENCE_FIELD');
    if (key === 'labels' && value && typeof value === 'object') {
      for (const labelKey of Object.keys(value)) {
        if (forbiddenKey.test(labelKey)) throw new Error('FORBIDDEN_EVIDENCE_FIELD');
      }
    }
  }
  canonicalize(payload);
}

export function createEvidenceIdentity(input: EvidenceInput): string {
  if (input.canonicalizationVersion !== 'canonical-json/v1') {
    throw new Error('UNKNOWN_CANONICALIZATION_VERSION');
  }
  validatePayload(input.normalizedPayload);
  const observedAt = new Date(input.observedAt);
  if (!Number.isFinite(observedAt.getTime()) || observedAt.toISOString() !== input.observedAt) {
    throw new Error('INVALID_OBSERVATION_TIME');
  }
  const payloadDigest = sha256(canonicalize(input.normalizedPayload));
  return `ev_${sha256(
    canonicalize({
      canonicalizationVersion: input.canonicalizationVersion,
      collectorVersion: input.collectorVersion,
      observedAt: input.observedAt,
      payloadDigest,
      redactionVersion: input.redactionVersion,
      sourceLocator: input.sourceLocator,
    }),
  )}`;
}
