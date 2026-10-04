import { afterEach, describe, expect, it, vi } from 'vitest';

import { appMetadata } from '../src/config/app.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Mastra registration', () => {
  it('registers exactly one stable agent and workflow', async () => {
    const configured = {
      MODEL_ID: 'openai/gpt-4o-mini',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/incident_triage',
      INCIDENT_HMAC_SECRET: 'a-secret-that-is-at-least-thirty-two-characters',
      JWT_ISSUER: 'https://identity.example.com/',
      JWT_AUDIENCE: 'incident-triage-agent',
      JWT_JWKS_URL: 'https://identity.example.com/.well-known/jwks.json',
    };
    for (const [name, value] of Object.entries(configured)) vi.stubEnv(name, value);

    const { mastra } = await import('../src/mastra/index.js');

    expect(Object.keys(mastra.listAgents())).toEqual([appMetadata.agentId]);
    expect(Object.keys(mastra.listWorkflows())).toEqual([appMetadata.workflowId]);
    expect(
      mastra.getServer()?.apiRoutes?.map((route) => [route.method, route.path, route.requiresAuth]),
    ).toEqual(
      expect.arrayContaining([
        ['POST', '/incidents', false],
        ['GET', '/cases/:caseId', undefined],
        ['GET', '/health', false],
        ['GET', '/readyz', false],
      ]),
    );
  });
});
