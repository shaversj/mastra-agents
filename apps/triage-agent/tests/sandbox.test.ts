import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceTools, type Workspace } from '@mastra/core/workspace';

import { createTriageCodingAgent } from '../src/mastra/agents/triage.js';
import {
  secureGitEnvironment,
  trustedExecutableDirectories,
} from '../src/security/git-environment.js';
import {
  createMaterializedWorkspace,
  createSecureWorkspace,
  resolveSandboxIsolation,
  type SandboxFactoryOptions,
  type WorkspaceFactoryOptions,
} from '../src/security/workspace.js';

const fixtureRoot = new URL('./fixtures/repositories/basic/', import.meta.url).pathname;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('sandbox isolation and tool boundary', () => {
  it('fails closed before model work when Linux bwrap is unavailable', () => {
    expect(() =>
      resolveSandboxIsolation({
        detectIsolation: () => ({ available: false, backend: 'none', message: 'missing' }),
        platform: 'linux',
      }),
    ).toThrow('SANDBOX_BWRAP_UNAVAILABLE');
  });

  it('requires exact bwrap isolation on Linux', () => {
    expect(
      resolveSandboxIsolation({
        detectIsolation: () => ({ available: true, backend: 'bwrap', message: 'ready' }),
        platform: 'linux',
      }),
    ).toBe('bwrap');
  });

  it('rejects a non-bwrap workspace configuration on Linux', () => {
    expect(() =>
      createSecureWorkspace({
        factories: {
          createFilesystem: vi.fn(),
          createSandbox: vi.fn(),
          createSkillSource: vi.fn(),
          createWorkspace: vi.fn(),
        },
        isolation: 'seatbelt',
        platform: 'linux',
        triageSkillPath: '/tmp/skills/triage/SKILL.md',
        workspaceRoot: '/tmp/materialized/workspace',
      }),
    ).toThrow('SANDBOX_BWRAP_REQUIRED');
  });

  it('constructs a contained, credential-free workspace with only foreground tools', () => {
    let filesystemOptions: unknown;
    let sandboxOptions: SandboxFactoryOptions | undefined;
    let workspaceOptions: WorkspaceFactoryOptions | undefined;
    const workspace = createSecureWorkspace({
      commandLimits: { maxCommands: 3 },
      factories: {
        createFilesystem: (options) => {
          filesystemOptions = options;
          return { kind: 'filesystem' };
        },
        createSandbox: (options) => {
          sandboxOptions = options;
          return { kind: 'sandbox' };
        },
        createSkillSource: (options) => ({ ...options, kind: 'skill-source' }),
        createWorkspace: (options) => {
          workspaceOptions = options;
          return { kind: 'workspace' };
        },
      },
      isolation: 'bwrap',
      platform: 'linux',
      preparedReadOnlyPaths: ['/tmp/prepared/node_modules'],
      triageSkillPath: '/tmp/skills/triage/SKILL.md',
      workspaceRoot: '/tmp/materialized/workspace',
    });

    expect(workspace).toEqual({ kind: 'workspace' });
    expect(filesystemOptions).toMatchObject({
      allowedPaths: [],
      basePath: '/tmp/materialized/workspace',
      contained: true,
    });
    expect(sandboxOptions).toMatchObject({
      env: secureGitEnvironment(),
      isolation: 'bwrap',
      nativeSandbox: {
        allowNetwork: false,
        allowSystemBinaries: false,
        readWritePaths: [],
      },
      workingDirectory: '/tmp/materialized/workspace',
    });
    expect(sandboxOptions?.nativeSandbox?.readOnlyPaths).toEqual([
      ...new Set([...trustedExecutableDirectories, '/tmp/prepared/node_modules']),
    ]);
    expect(sandboxOptions?.nativeSandbox).not.toHaveProperty('bwrapArgs');
    expect(workspaceOptions?.skills).toEqual(['triage/SKILL.md']);
    expect(workspaceOptions?.skillSource).toMatchObject({
      basePath: '/tmp/skills',
      kind: 'skill-source',
    });

    const enabledTools = Object.entries(workspaceOptions?.tools ?? {})
      .filter(
        ([, value]) =>
          typeof value === 'object' &&
          value !== null &&
          'enabled' in value &&
          value.enabled === true,
      )
      .map(([name]) => name)
      .sort();
    expect(workspaceOptions?.tools.enabled).toBe(false);
    expect(enabledTools).toEqual([
      'mastra_workspace_edit_file',
      'mastra_workspace_execute_command',
      'mastra_workspace_file_stat',
      'mastra_workspace_grep',
      'mastra_workspace_list_files',
      'mastra_workspace_read_file',
      'mastra_workspace_write_file',
    ]);
    expect(workspaceOptions?.tools.mastra_workspace_write_file).toMatchObject({
      requireReadBeforeWrite: true,
    });
    expect(workspaceOptions?.tools.mastra_workspace_execute_command).toMatchObject({
      background: { enabled: false },
    });
  });

  it('exposes the exact tool allowlist from the real Mastra workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'triage-tools-'));
    const workspace = createSecureWorkspace({
      isolation: resolveSandboxIsolation(),
      triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
      workspaceRoot,
    }) as Workspace;
    cleanups.push(async () => {
      await workspace.destroy();
    });

    const tools = await createWorkspaceTools(workspace);
    expect(Object.keys(tools).sort()).toEqual([
      'mastra_workspace_edit_file',
      'mastra_workspace_execute_command',
      'mastra_workspace_file_stat',
      'mastra_workspace_grep',
      'mastra_workspace_list_files',
      'mastra_workspace_read_file',
      'mastra_workspace_write_file',
    ]);
    await expect(workspace.skills?.list()).resolves.toEqual([
      expect.objectContaining({ name: 'triage-skill' }),
    ]);
  });

  it.runIf(process.platform === 'linux')(
    'enforces the production bwrap environment, network, and host-write boundary',
    async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'triage-bwrap-'));
      const outsideRoot = await mkdtemp(join(tmpdir(), 'triage-bwrap-outside-'));
      const outsideMarker = join(outsideRoot, 'marker.txt');
      const workspace = createSecureWorkspace({
        isolation: 'bwrap',
        triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
        workspaceRoot,
      }) as Workspace;
      cleanups.push(async () => {
        await workspace.destroy();
      });
      cleanups.push(async () => {
        await rm(outsideRoot, { force: true, recursive: true });
      });

      await workspace.init();
      const sandbox = workspace.sandbox;
      if (!sandbox?.getInfo || !sandbox.executeCommand)
        throw new Error('fixture sandbox unavailable');
      const info = await sandbox.getInfo();
      expect(info?.metadata?.isolation).toBe('bwrap');
      const result = await sandbox.executeCommand(
        'test -z "$GITHUB_TOKEN" && test -z "$OPENAI_API_KEY" && test ! -e .git',
      );
      expect(result?.success).toBe(true);

      const deniedEgress = await sandbox.executeCommand(
        'node',
        [
          '-e',
          [
            "const net = require('node:net');",
            "const socket = net.connect({ host: '1.1.1.1', port: 443 });",
            "socket.once('connect', () => { console.error('EGRESS_ALLOWED'); process.exit(9); });",
            "socket.once('error', () => { console.log('EGRESS_DENIED'); process.exit(0); });",
            "setTimeout(() => { console.error('EGRESS_TIMEOUT'); process.exit(8); }, 2_000);",
          ].join(' '),
        ],
        { timeout: 5_000 },
      );
      expect(deniedEgress?.success).toBe(true);
      expect(deniedEgress?.stdout).toContain('EGRESS_DENIED');

      const deniedHostWrite = await sandbox.executeCommand(
        'node',
        [
          '-e',
          [
            "const fs = require('node:fs');",
            "try { fs.writeFileSync(process.argv[1], 'owned');",
            "console.error('HOST_WRITE_ALLOWED'); process.exit(9); }",
            "catch { console.log('HOST_WRITE_DENIED'); process.exit(0); }",
          ].join(' '),
          outsideMarker,
        ],
        { timeout: 5_000 },
      );
      expect(deniedHostWrite?.success).toBe(true);
      expect(deniedHostWrite?.stdout).toContain('HOST_WRITE_DENIED');
      await expect(stat(outsideMarker)).rejects.toThrow();

      await expect(sandbox.executeCommand('yes', [], { timeout: 5000 })).rejects.toThrow(
        'WORKSPACE_OUTPUT_LIMIT',
      );
    },
  );
});

describe('materialized workspace lifecycle', () => {
  it('runs setup before the baseline and never copies Git metadata or ambient secrets', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'triage-source-'));
    await mkdir(join(sourceRoot, '.git'));
    await writeFile(join(sourceRoot, '.git', 'config'), 'token=secret');
    await writeFile(join(sourceRoot, '.env'), 'TOKEN=secret');
    await writeFile(join(sourceRoot, 'source.txt'), 'source\n');

    let executeCommand = vi.fn(async () => ({
      executionTimeMs: 1,
      exitCode: 0,
      stderr: '',
      stdout: '',
      success: true,
    }));
    const result = await createMaterializedWorkspace({
      buildCommand: 'pnpm build',
      createSecureWorkspace: ({ workspaceRoot }) => {
        executeCommand = vi.fn(async () => {
          await writeFile(join(workspaceRoot, 'generated.txt'), 'prepared\n');
          return { executionTimeMs: 1, exitCode: 0, stderr: '', stdout: '', success: true };
        });
        return {
          destroy: vi.fn(async () => undefined),
          sandbox: { executeCommand },
          workspaceRoot,
        };
      },
      sourceFiles: ['source.txt'],
      sourceRoot,
      triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
    });
    cleanups.push(result.cleanup);

    expect(executeCommand).toHaveBeenCalledOnce();
    expect(await readFile(join(result.workspaceRoot, 'source.txt'), 'utf8')).toBe('source\n');
    await expect(stat(join(result.workspaceRoot, '.git'))).rejects.toThrow();
    await expect(stat(join(result.workspaceRoot, '.env'))).rejects.toThrow();
    expect(result.baseline.files['source.txt']?.digest).toBeTruthy();
    expect(result.baseline.files['generated.txt']?.digest).toBeTruthy();
  });

  it('classifies missing prepared dependencies and build failures as setup failures', async () => {
    await expect(
      createMaterializedWorkspace({
        preparedPaths: [{ source: '/definitely/missing', target: 'node_modules' }],
        sourceFiles: ['package.json'],
        sourceRoot: fixtureRoot,
        triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
      }),
    ).rejects.toThrow('WORKSPACE_PREREQUISITE_MISSING');

    await expect(
      createMaterializedWorkspace({
        buildCommand: 'false',
        createSecureWorkspace: ({ workspaceRoot }) => ({
          destroy: vi.fn(async () => undefined),
          sandbox: {
            executeCommand: vi.fn(async () => ({
              exitCode: 1,
              executionTimeMs: 1,
              stderr: 'fixture failure',
              stdout: '',
              success: false,
            })),
          },
          workspaceRoot,
        }),
        sourceFiles: ['package.json'],
        sourceRoot: fixtureRoot,
        triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
      }),
    ).rejects.toThrow('WORKSPACE_BUILD_FAILED');
  });

  it('rejects inherited Git control variables before materialization', async () => {
    await expect(
      createMaterializedWorkspace({
        environment: { GIT_DIR: '/tmp/attacker' },
        sourceFiles: ['package.json'],
        sourceRoot: fixtureRoot,
        triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
      }),
    ).rejects.toThrow('UNSAFE_GIT_ENVIRONMENT');
  });

  it.each(['.npmrc', '.ssh/id_ed25519', 'config/.env.production'])(
    'rejects credential-bearing source path %s',
    async (path) => {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'triage-protected-source-'));
      await mkdir(join(sourceRoot, path, '..'), { recursive: true });
      await writeFile(join(sourceRoot, path), 'fixture\n');
      await expect(
        createMaterializedWorkspace({
          sourceFiles: [path],
          sourceRoot,
          triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
        }),
      ).rejects.toThrow('WORKSPACE_SOURCE_PROTECTED');
    },
  );

  it('rejects credential-like content in an otherwise allowed source file', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'triage-secret-source-'));
    await writeFile(
      join(sourceRoot, 'config.txt'),
      'github_pat_abcdefghijklmnopqrstuvwxyz_1234567890\n',
    );
    await expect(
      createMaterializedWorkspace({
        sourceFiles: ['config.txt'],
        sourceRoot,
        triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
      }),
    ).rejects.toThrow('WORKSPACE_SOURCE_CREDENTIAL');
  });

  it('rejects credentials in a prepared dependency tree', async () => {
    const prepared = await mkdtemp(join(tmpdir(), 'triage-secret-prepared-'));
    cleanups.push(() => rm(prepared, { force: true, recursive: true }));
    await writeFile(join(prepared, '.npmrc'), '//registry.example.com/:_authToken=secret\n');

    await expect(
      createMaterializedWorkspace({
        preparedPaths: [{ source: prepared, target: 'prepared' }],
        sourceFiles: ['package.json'],
        sourceRoot: fixtureRoot,
        triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
      }),
    ).rejects.toThrow('WORKSPACE_PREPARED_CREDENTIAL_FILE');
  });

  it('enforces aggregate materialization ceilings before setup execution', async () => {
    const prepared = await mkdtemp(join(tmpdir(), 'triage-prepared-'));
    await writeFile(join(prepared, 'large.txt'), 'x'.repeat(32));
    const create = vi.fn();
    await expect(
      createMaterializedWorkspace({
        createSecureWorkspace: create,
        diffLimits: { maxWorkspaceBytes: 16 },
        preparedPaths: [{ source: prepared, target: 'prepared' }],
        sourceFiles: ['package.json'],
        sourceRoot: fixtureRoot,
        triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
      }),
    ).rejects.toThrow('WORKSPACE_BYTES_EXCEEDED');
    expect(create).not.toHaveBeenCalled();
  });

  it('cleans owner-only temporary materialization roots', async () => {
    const result = await createMaterializedWorkspace({
      createSecureWorkspace: ({ workspaceRoot }) => ({
        destroy: vi.fn(async () => undefined),
        sandbox: {},
        workspaceRoot,
      }),
      sourceFiles: ['package.json'],
      sourceRoot: fixtureRoot,
      triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
    });
    const materializationRoot = result.materializationRoot;
    expect((await stat(materializationRoot)).mode & 0o777).toBe(0o700);
    await result.cleanup();
    await expect(stat(materializationRoot)).rejects.toThrow();
  });
});

it('creates an injectable Mastra coding agent without extra mutation tools', () => {
  const factory = vi.fn((config) => config);
  const workspace = { id: 'fixture-workspace' };
  const agent = createTriageCodingAgent({
    createAgent: factory,
    history: {
      blame: vi.fn(async () => []),
      log: vi.fn(async () => []),
    },
    model: 'fixture/model',
    workspace,
  });

  expect(agent).toMatchObject({
    defaultGenerateOptionsLegacy: { maxSteps: 12 },
    defaultOptions: { maxSteps: 12 },
    id: 'triage-coding-agent',
    model: 'fixture/model',
    workspace,
  });
  expect(Object.keys(factory.mock.calls[0]?.[0].tools ?? {}).sort()).toEqual([
    'history_blame',
    'history_log',
  ]);
  expect(factory.mock.calls[0]?.[0].instructions).toContain('untrusted');
});
