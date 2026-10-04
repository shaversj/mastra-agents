import { describe, expect, it } from 'vitest';

import { appMetadata, loadAppConfig } from '../src/config/app.js';

const validEnvironment = {
  MODEL_ID: 'openai/gpt-4o-mini',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/incident_triage',
  INCIDENT_HMAC_SECRET: 'a-secret-that-is-at-least-thirty-two-characters',
  JWT_ISSUER: 'https://identity.example.com/',
  JWT_AUDIENCE: 'incident-triage-agent',
  JWT_JWKS_URL: 'https://identity.example.com/.well-known/jwks.json',
};

describe('incident app config', () => {
  it('owns stable package, application, agent, and workflow identities', () => {
    expect(appMetadata).toEqual({
      packageName: '@mastra-agents/incident-triage-agent',
      appId: 'incident-triage-agent',
      agentId: 'incident-triage-agent',
      workflowId: 'incident-triage-workflow',
    });
  });

  it('loads required settings and bounded defaults', () => {
    expect(loadAppConfig(validEnvironment)).toMatchObject({
      modelId: 'openai/gpt-4o-mini',
      databaseUrl: validEnvironment.DATABASE_URL,
      jwtIssuer: validEnvironment.JWT_ISSUER,
      jwtAudience: 'incident-triage-agent',
      processRole: 'api',
      host: '127.0.0.1',
      port: 4111,
      evidenceRetentionDays: 30,
      traceRetentionDays: 7,
      governanceRetentionDays: 2555,
      approvalTtlSeconds: 3600,
      workerLeaseSeconds: 60,
      modelTimeoutMs: 30_000,
    });
  });

  it.each([
    'MODEL_ID',
    'DATABASE_URL',
    'INCIDENT_HMAC_SECRET',
    'JWT_ISSUER',
    'JWT_AUDIENCE',
    'JWT_JWKS_URL',
  ])('rejects a missing %s without exposing other values', (name) => {
    const environment = { ...validEnvironment, [name]: undefined, SOME_SECRET: 'never-print-me' };

    expect(() => loadAppConfig(environment)).toThrowError(name);
    try {
      loadAppConfig(environment);
    } catch (error) {
      expect(String(error)).not.toContain('never-print-me');
    }
  });

  it.each([
    ['DATABASE_URL', 'not-a-url'],
    ['INCIDENT_HMAC_SECRET', 'short'],
    ['JWT_ISSUER', 'not-a-url'],
    ['JWT_JWKS_URL', 'file:///tmp/jwks.json'],
    ['PROCESS_ROLE', 'both'],
    ['PORT', '0'],
    ['EVIDENCE_RETENTION_DAYS', '0'],
    ['MODEL_TIMEOUT_MS', '600001'],
  ])('rejects malformed %s by variable name', (name, value) => {
    expect(() => loadAppConfig({ ...validEnvironment, [name]: value })).toThrowError(name);
  });
});
