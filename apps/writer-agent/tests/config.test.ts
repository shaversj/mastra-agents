import { describe, expect, it } from 'vitest';

import { appMetadata, loadAppConfig } from '../src/config/app.js';

describe('app config', () => {
  it('owns the package, application, and agent identities', () => {
    expect(appMetadata).toEqual({
      packageName: '@mastra-agents/writer-agent',
      appId: 'writer-agent',
      agentId: 'writer-agent',
    });
  });

  it('loads the required model and loopback server defaults', () => {
    expect(loadAppConfig({ MODEL_ID: 'openai/gpt-4o-mini' })).toEqual({
      modelId: 'openai/gpt-4o-mini',
      host: '127.0.0.1',
      port: 4111,
    });
  });

  it('names MODEL_ID without exposing another environment value', () => {
    const secret = 'do-not-print-this';

    expect(() => loadAppConfig({ SOME_SECRET: secret })).toThrowError(
      'Missing required environment variable: MODEL_ID',
    );

    try {
      loadAppConfig({ SOME_SECRET: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('rejects an invalid port by variable name', () => {
    expect(() =>
      loadAppConfig({ MODEL_ID: 'openai/gpt-4o-mini', PORT: 'not-a-port' }),
    ).toThrowError('Invalid environment variable: PORT');
  });
});
