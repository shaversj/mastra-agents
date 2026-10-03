import { afterEach, describe, expect, it, vi } from 'vitest';

import { appMetadata } from '../src/config/app.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('agent registration', () => {
  it('registers exactly one agent under the stable agent id', async () => {
    vi.stubEnv('MODEL_ID', 'openai/gpt-4o-mini');

    const { mastra } = await import('../src/mastra/index.js');
    const agents = mastra.listAgents();

    expect(Object.keys(agents)).toEqual([appMetadata.agentId]);
    expect(agents[appMetadata.agentId]?.id).toBe(appMetadata.agentId);
  });
});
