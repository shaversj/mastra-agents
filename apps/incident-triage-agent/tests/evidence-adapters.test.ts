import { describe, expect, it } from 'vitest';

import { FixtureEvidenceAdapter } from '../src/evidence/adapters/fixture.js';
import { collectEvidence } from '../src/evidence/adapters/types.js';

describe('evidence adapters', () => {
  it('keeps partial adapter failure reason-coded without fabricated evidence', async () => {
    const available = new FixtureEvidenceAdapter('metrics', {
      'incident-1': [
        {
          sourceLocator: 'metrics/api',
          observedAt: '2026-10-03T18:00:00.000Z',
          normalizedPayload: { value: 3, unit: 'errors_per_second' },
        },
      ],
    });
    const unavailable = {
      source: 'logs',
      collect: async () => {
        throw new Error('credential was rejected by vendor');
      },
    };

    const result = await collectEvidence('incident-1', [available, unavailable]);

    expect(result.items).toHaveLength(1);
    expect(result.failures).toEqual([{ source: 'logs', reasonCode: 'ADAPTER_UNAVAILABLE' }]);
    expect(JSON.stringify(result)).not.toContain('credential was rejected');
  });
});
