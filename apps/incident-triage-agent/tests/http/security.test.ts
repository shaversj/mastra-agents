import { describe, expect, it } from 'vitest';

import { isAuthorized } from '../../src/http/middleware/authorize.js';
import {
  createIncidentSignature,
  verifyIncidentSignature,
} from '../../src/http/middleware/hmac.js';

describe('HTTP security boundaries', () => {
  it('accepts a fresh raw-body signature and rejects tampering or stale timestamps', () => {
    const secret = 'a-secret-that-is-at-least-thirty-two-characters';
    const timestamp = '1791079200';
    const rawBody = '{"deliveryId":"delivery-1"}';
    const signature = createIncidentSignature(secret, timestamp, rawBody);
    const now = new Date(Number(timestamp) * 1000);

    expect(verifyIncidentSignature({ secret, timestamp, signature, rawBody, now })).toBe(true);
    expect(
      verifyIncidentSignature({ secret, timestamp, signature, rawBody: `${rawBody} `, now }),
    ).toBe(false);
    expect(
      verifyIncidentSignature({
        secret,
        timestamp,
        signature,
        rawBody,
        now: new Date(now.getTime() + 301_000),
      }),
    ).toBe(false);
  });

  it('authorizes only server-authenticated principals with an allowed role', () => {
    expect(
      isAuthorized({ subject: 'operator', roles: ['incident-operator'] }, ['incident-operator']),
    ).toBe(true);
    expect(isAuthorized({ subject: 'viewer', roles: ['viewer'] }, ['incident-operator'])).toBe(
      false,
    );
    expect(isAuthorized(undefined, ['incident-operator'])).toBe(false);
  });
});
