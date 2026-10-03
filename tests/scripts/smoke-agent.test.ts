import { describe, expect, it } from 'vitest';

import {
  smokeAgent,
  type CommandResult,
  type SmokeDependencies,
} from '../../scripts/smoke-agent.mjs';

interface FakeRuntime {
  commands: string[][];
  dependencies: SmokeDependencies;
}

function commandResult(stdout = '', stderr = ''): CommandResult {
  return { stdout, stderr };
}

function createRuntime(
  fetchResponses: Response[],
  logs = '',
  state = '{"Status":"exited","ExitCode":0,"OOMKilled":false}\n',
): FakeRuntime {
  const commands: string[][] = [];
  let now = 0;

  return {
    commands,
    dependencies: {
      fetch: async () => {
        const response = fetchResponses.shift();
        if (!response) {
          throw new Error('Unexpected fetch');
        }
        return response;
      },
      now: () => now,
      randomUUID: () => '00000000-0000-4000-8000-000000000000',
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      runDocker: async (arguments_) => {
        commands.push(arguments_);

        switch (arguments_[0]) {
          case 'run':
            return commandResult('container-id\n');
          case 'port':
            return commandResult('127.0.0.1:49152\n');
          case 'stop':
            return commandResult('container-name\n');
          case 'inspect':
            return commandResult(state);
          case 'logs':
            return commandResult(logs);
          case 'rm':
            return commandResult();
          default:
            throw new Error(`Unexpected Docker command: ${arguments_.join(' ')}`);
        }
      },
    },
  };
}

describe('container smoke harness', () => {
  it('probes the app-owned identity and stops a loopback-published container cleanly', async () => {
    const runtime = createRuntime([
      Response.json({ success: true }),
      Response.json({ 'researcher-agent': { name: 'Researcher Agent' } }),
    ]);

    await expect(
      smokeAgent(
        {
          appName: 'researcher-agent',
          image: 'mastra-agents/researcher-agent:test',
        },
        runtime.dependencies,
      ),
    ).resolves.toEqual({ agentId: 'researcher-agent', port: 49152 });

    const run = runtime.commands.find(([command]) => command === 'run');
    expect(run).toEqual(
      expect.arrayContaining([
        '--publish',
        '127.0.0.1::4111',
        '--env',
        'HOST=0.0.0.0',
        '--env',
        'MODEL_ID=openai/gpt-4o-mini',
      ]),
    );
    expect(run).not.toContain('--volume');
    expect(runtime.commands).toContainEqual(expect.arrayContaining(['stop', '--time', '10']));
    expect(runtime.commands).toContainEqual([
      'inspect',
      '--format',
      '{{json .State}}',
      'mastra-smoke-researcher-agent-00000000',
    ]);
    expect(runtime.commands.at(-1)).toEqual([
      'rm',
      '--force',
      'mastra-smoke-researcher-agent-00000000',
    ]);
  });

  it('times out, bounds logs, and cleans up a container that never becomes healthy', async () => {
    const runtime = createRuntime(
      Array.from({ length: 4 }, () => new Response(null, { status: 503 })),
      `${'old log\n'.repeat(20_000)}final log line`,
    );

    await expect(
      smokeAgent(
        {
          appName: 'researcher-agent',
          image: 'mastra-agents/researcher-agent:test',
          startupTimeoutMs: 300,
        },
        runtime.dependencies,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      const message = String(error);
      expect(message).toContain('did not become healthy within 300ms');
      expect(message).toContain('[earlier container logs truncated]');
      expect(message).toContain('final log line');
      expect(Buffer.byteLength(message)).toBeLessThan(70 * 1024);
      return true;
    });

    expect(runtime.commands.some(([command]) => command === 'logs')).toBe(true);
    expect(runtime.commands.some(([command]) => command === 'stop')).toBe(true);
    expect(runtime.commands.at(-1)?.slice(0, 2)).toEqual(['rm', '--force']);
  });

  it('rejects the wrong registered agent identity and still cleans up', async () => {
    const runtime = createRuntime([
      Response.json({ success: true }),
      Response.json({ 'writer-agent': { name: 'Writer Agent' } }),
    ]);

    await expect(
      smokeAgent(
        {
          appName: 'researcher-agent',
          image: 'mastra-agents/researcher-agent:test',
        },
        runtime.dependencies,
      ),
    ).rejects.toThrow('unexpected agent ids: writer-agent');

    expect(runtime.commands.some(([command]) => command === 'stop')).toBe(true);
    expect(runtime.commands.at(-1)?.slice(0, 2)).toEqual(['rm', '--force']);
  });

  it('fails when Docker reports a SIGKILL-style exit instead of graceful shutdown', async () => {
    const runtime = createRuntime(
      [
        Response.json({ success: true }),
        Response.json({ 'researcher-agent': { name: 'Researcher Agent' } }),
      ],
      '',
      '{"Status":"exited","ExitCode":137,"OOMKilled":false}\n',
    );

    await expect(
      smokeAgent(
        {
          appName: 'researcher-agent',
          image: 'mastra-agents/researcher-agent:test',
        },
        runtime.dependencies,
      ),
    ).rejects.toThrow('did not exit cleanly after SIGTERM');

    expect(runtime.commands.at(-1)?.slice(0, 2)).toEqual(['rm', '--force']);
  });
});
