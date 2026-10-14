import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceTools, type Workspace } from '@mastra/core/workspace';

import { createTriageCodingAgent } from '../src/mastra/agents/triage.js';
import { secureGitEnvironment } from '../src/security/git-environment.js';
import {
  createMaterializedWorkspace,
  createSecureWorkspace,
  assertDockerSandboxAvailable,
  triageSandboxImage,
  type SandboxFactoryOptions,
  type WorkspaceFactoryOptions,
} from '../src/security/workspace.js';

const fixtureRoot = new URL('./fixtures/repositories/basic/', import.meta.url).pathname;
const cleanups: Array<() => Promise<void>> = [];

function hostIdentity(): { gid: number; uid: number } {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new Error('fixture requires a POSIX host identity');
  }
  return { gid: process.getgid(), uid: process.getuid() };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('sandbox isolation and tool boundary', () => {
  it('fails closed before model work when Docker is unavailable', async () => {
    await expect(
      assertDockerSandboxAvailable({
        checkDocker: () => false,
      }),
    ).rejects.toThrow('SANDBOX_DOCKER_UNAVAILABLE');
  });

  it('accepts an available Docker daemon', async () => {
    await expect(
      assertDockerSandboxAvailable({
        checkDocker: () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it('constructs a contained, credential-free workspace with only foreground tools', () => {
    const { gid, uid } = hostIdentity();
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
      capDrop: ['ALL'],
      env: {
        ...secureGitEnvironment(),
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      },
      image: triageSandboxImage,
      memory: 1024 * 1024 * 1024,
      memorySwap: 1024 * 1024 * 1024,
      network: 'none',
      pidsLimit: 64,
      privileged: false,
      readonlyRootfs: true,
      sandboxUser: `${uid}:${gid}`,
      securityOpt: ['no-new-privileges:true'],
      workingDirectory: '/workspace',
    });
    expect(sandboxOptions?.mounts).toEqual([
      {
        readOnly: false,
        source: '/tmp/materialized/workspace',
        target: '/workspace',
        type: 'bind',
      },
      {
        readOnly: true,
        source: '/tmp/prepared/node_modules',
        target: '/tmp/prepared/node_modules',
        type: 'bind',
      },
    ]);
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
    expect(
      workspaceOptions?.tools.hooks?.beforeToolCall?.({ input: { background: true } } as never),
    ).toEqual({ output: { error: 'BACKGROUND_EXECUTION_DISABLED' }, proceed: false });
  });

  it('exposes the exact tool allowlist from the real Mastra workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'triage-tools-'));
    const workspace = createSecureWorkspace({
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

  it('enforces the production Docker environment, network, and host-write boundary', async () => {
    const { uid } = hostIdentity();
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'triage-docker-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'triage-docker-outside-'));
    const preparedRoot = await mkdtemp(join(tmpdir(), 'triage-docker-prepared-'));
    const outsideMarker = join(outsideRoot, 'marker.txt');
    const preparedFile = join(preparedRoot, 'dependency.txt');
    await writeFile(preparedFile, 'prepared\n');
    const workspace = createSecureWorkspace({
      preparedReadOnlyPaths: [preparedRoot],
      triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
      workspaceRoot,
    }) as Workspace;
    cleanups.push(async () => {
      await workspace.destroy();
    });
    cleanups.push(async () => {
      await rm(outsideRoot, { force: true, recursive: true });
    });
    cleanups.push(async () => {
      await rm(preparedRoot, { force: true, recursive: true });
    });

    await workspace.init();
    const sandbox = workspace.sandbox;
    if (!sandbox?.getInfo || !sandbox.executeCommand)
      throw new Error('fixture sandbox unavailable');
    const info = await sandbox.getInfo();
    expect(info?.provider).toBe('docker');
    const identity = await sandbox.executeCommand('id', ['-u']);
    expect(identity?.stdout.trim()).toBe(String(uid));
    const workspaceWrite = await sandbox.executeCommand('sh', [
      '-c',
      'mkdir -p generated/nested && printf ok > generated/nested/result.txt',
    ]);
    expect(workspaceWrite?.success).toBe(true);
    expect(await readFile(join(workspaceRoot, 'generated/nested/result.txt'), 'utf8')).toBe('ok');
    const readOnlyRoot = await sandbox.executeCommand('sh', [
      '-c',
      'test ! -w /usr && touch /tmp/triage-write-test',
    ]);
    expect(readOnlyRoot?.success).toBe(true);
    const chainedCommand = await sandbox.executeCommand('true && false');
    expect(chainedCommand?.success).toBe(false);
    const separatedOutput = await sandbox.executeCommand('sh', [
      '-c',
      'printf stdout-value; printf stderr-value >&2',
    ]);
    expect(separatedOutput?.stdout).toBe('stdout-value');
    expect(separatedOutput?.stderr).toBe('stderr-value');
    const droppedCapabilities = await sandbox.executeCommand(
      "awk '/^Cap(Inh|Prm|Eff|Bnd|Amb):/ { print }' /proc/self/status",
    );
    expect(
      droppedCapabilities?.success,
      JSON.stringify({
        exitCode: droppedCapabilities?.exitCode,
        stderr: droppedCapabilities?.stderr,
        stdout: droppedCapabilities?.stdout,
      }),
    ).toBe(true);
    expect(
      droppedCapabilities?.stdout,
      JSON.stringify({ stdout: droppedCapabilities?.stdout }),
    ).toMatch(/^CapEff:\s*0+$/mu);
    const result = await sandbox.executeCommand(
      'test -z "$GITHUB_TOKEN" && test -z "$OPENAI_API_KEY" && test ! -e .git',
    );
    expect(
      result?.success,
      JSON.stringify({ exitCode: result?.exitCode, stderr: result?.stderr }),
    ).toBe(true);

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

    const readOnlyDependency = await sandbox.executeCommand('node', [
      '-e',
      [
        "const fs = require('node:fs');",
        "if (fs.readFileSync(process.argv[1], 'utf8') !== 'prepared\\n') process.exit(7);",
        "try { fs.writeFileSync(process.argv[1], 'changed'); process.exit(8); }",
        "catch { console.log('PREPARED_READ_ONLY'); }",
      ].join(' '),
      preparedFile,
    ]);
    expect(readOnlyDependency?.success).toBe(true);
    expect(readOnlyDependency?.stdout).toContain('PREPARED_READ_ONLY');
    expect(await readFile(preparedFile, 'utf8')).toBe('prepared\n');

    await expect(sandbox.executeCommand('yes')).rejects.toThrow('WORKSPACE_OUTPUT_LIMIT');
    await expect(sandbox.executeCommand('true')).resolves.toMatchObject({ success: true });
  }, 30_000);
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

  it('rejects PKCS#8 private keys in source materialization', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'triage-secret-source-'));
    await writeFile(join(sourceRoot, 'config.txt'), '-----BEGIN PRIVATE KEY-----\nfixture\n');
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

  it('rejects private-key content in a prepared dependency tree', async () => {
    const prepared = await mkdtemp(join(tmpdir(), 'triage-secret-prepared-'));
    cleanups.push(() => rm(prepared, { force: true, recursive: true }));
    await writeFile(
      join(prepared, 'fixture.txt'),
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nfixture\n',
    );

    await expect(
      createMaterializedWorkspace({
        preparedPaths: [{ source: prepared, target: 'prepared' }],
        sourceFiles: ['package.json'],
        sourceRoot: fixtureRoot,
        triageSkillPath: join(fixtureRoot, 'triage-skill', 'SKILL.md'),
      }),
    ).rejects.toThrow('WORKSPACE_PREPARED_CREDENTIAL_CONTENT');
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
