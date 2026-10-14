import { createMockModel } from '@mastra/core/test-utils/llm-mock';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { describe, expect, it, vi } from 'vitest';

import { appMetadata } from '../src/config/app.js';
import type { TriageAgentModel } from '../src/mastra/agents/triage.js';
import { createTriageMastra } from '../src/mastra/index.js';

describe('Mastra registration', () => {
  it('registers the stable agent and both event-scoped workflows without provider configuration', () => {
    const mastra = createTriageMastra({
      history: { blame: vi.fn(), log: vi.fn() },
      invokeModel: async () => ({ object: { decision: 'continue' }, toolCalls: [] }),
      model: createMockModel({ mockText: 'fixture', version: 'v2' }) as TriageAgentModel,
      workspace: new Workspace({
        filesystem: new LocalFilesystem({
          basePath: process.cwd(),
          contained: true,
          readOnly: true,
        }),
        id: 'fixture-workspace',
      }),
    });

    expect(Object.keys(mastra.listAgents())).toEqual([appMetadata.agentId]);
    expect(Object.keys(mastra.listWorkflows()).sort()).toEqual(
      [appMetadata.workflowIds.comment, appMetadata.workflowIds.triage].sort(),
    );
    expect(Object.keys(mastra.listScorers() ?? {})).toEqual([appMetadata.scorerId]);
  });
});
