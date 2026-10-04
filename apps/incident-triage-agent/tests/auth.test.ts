import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadAppConfig } from '../src/config/app.js';
import { createJwtAuthProvider } from '../src/security/auth.js';
import { hasRole } from '../src/security/roles.js';

const environment = {
  MODEL_ID: 'openai/gpt-4o-mini',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/incident_triage',
  INCIDENT_HMAC_SECRET: 'a-secret-that-is-at-least-thirty-two-characters',
  JWT_ISSUER: 'https://identity.example.com/',
  JWT_AUDIENCE: 'incident-triage-agent',
  JWT_JWKS_URL: 'https://identity.example.com/.well-known/jwks.json',
};

describe('JWT authentication', () => {
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let keyResolver: ReturnType<(typeof import('jose'))['createLocalJWKSet']>;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    keyResolver = (await import('jose')).createLocalJWKSet({
      keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' }],
    });
  });

  async function token(
    overrides: {
      issuer?: string;
      audience?: string;
      roles?: string[];
      expiresIn?: string;
      signingKey?: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
    } = {},
  ) {
    return new SignJWT({ roles: overrides.roles ?? ['incident-operator'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('operator-123')
      .setIssuer(overrides.issuer ?? environment.JWT_ISSUER)
      .setAudience(overrides.audience ?? environment.JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? '5m')
      .sign(overrides.signingKey ?? privateKey);
  }

  it('authenticates a correctly scoped operator principal', async () => {
    const provider = createJwtAuthProvider(loadAppConfig(environment), keyResolver);
    const principal = await provider.authenticateToken(await token(), new Request('http://local'));

    expect(principal).toEqual({ subject: 'operator-123', roles: ['incident-operator'] });
    expect(principal && hasRole(principal, 'incident-operator')).toBe(true);
  });

  it.each([
    { issuer: 'https://wrong.example.com/' },
    { audience: 'another-service' },
    { expiresIn: '-1s' },
    { roles: [] },
  ])('rejects invalid claims without leaking the token', async (overrides) => {
    const provider = createJwtAuthProvider(loadAppConfig(environment), keyResolver);
    const encoded = await token(overrides);

    await expect(
      provider.authenticateToken(encoded, new Request('http://local')),
    ).resolves.toBeNull();
  });

  it('rejects a token signed by an unknown key', async () => {
    const otherPair = await generateKeyPair('RS256');
    const provider = createJwtAuthProvider(loadAppConfig(environment), keyResolver);

    await expect(
      provider.authenticateToken(
        await token({ signingKey: otherPair.privateKey }),
        new Request('http://local'),
      ),
    ).resolves.toBeNull();
  });

  it('keeps workflow resume internal to the governed worker', () => {
    const provider = createJwtAuthProvider(loadAppConfig(environment), keyResolver);
    const principal = { subject: 'approver', roles: ['incident-approver'] };

    expect(
      provider.authorizeUser(
        principal,
        new Request('http://local/api/workflows/incident-triage-workflow/resume-async', {
          method: 'POST',
        }),
      ),
    ).toBe(false);
    expect(provider.authorizeUser(principal, new Request('http://local/cases/case-1'))).toBe(true);
  });
});
