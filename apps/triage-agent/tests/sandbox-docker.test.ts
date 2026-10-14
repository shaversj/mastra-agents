import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Workspace } from '@mastra/core/workspace';
import { type DockerSandbox } from '@mastra/docker';
import { afterEach, describe, expect, it } from 'vitest';

import { createSecureWorkspace } from '../src/security/workspace.js';

const fixtureRoot = new URL('./fixtures/repositories/basic/', import.meta.url).pathname;
const cleanups: Array<() => Promise<void>> = [];

const knownContainerStatuses = [
  'created',
  'dead',
  'exited',
  'paused',
  'removing',
  'restarting',
  'running',
] as const;

type KnownContainerStatus = (typeof knownContainerStatuses)[number];
type SanitizedContainerState =
  | { available: false }
  | {
      available: true;
      dead: boolean;
      exitCode: number | null;
      oomKilled: boolean;
      paused: boolean;
      restarting: boolean;
      running: boolean;
      status: KnownContainerStatus | 'unknown';
    };

function isKnownContainerStatus(status: unknown): status is KnownContainerStatus {
  return knownContainerStatuses.some((knownStatus) => knownStatus === status);
}

function hostUid(): number {
  if (typeof process.getuid !== 'function')
    throw new Error('fixture requires a POSIX host identity');
  return process.getuid();
}

async function inspectContainerState(sandbox: DockerSandbox): Promise<SanitizedContainerState> {
  try {
    const { State: state } = await sandbox.container.inspect();
    return {
      available: true,
      dead: state.Dead === true,
      exitCode:
        typeof state.ExitCode === 'number' && Number.isInteger(state.ExitCode)
          ? state.ExitCode
          : null,
      oomKilled: state.OOMKilled === true,
      paused: state.Paused === true,
      restarting: state.Restarting === true,
      running: state.Running === true,
      status: isKnownContainerStatus(state.Status) ? state.Status : 'unknown',
    };
  } catch {
    return { available: false };
  }
}

async function runProbe(
  name: string,
  sandbox: DockerSandbox,
  probe: () => Promise<void>,
): Promise<void> {
  try {
    await probe();
  } catch (error) {
    const state = await inspectContainerState(sandbox);
    throw new Error(`Docker probe ${JSON.stringify(name)} failed; state=${JSON.stringify(state)}`, {
      cause: error,
    });
  }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('production Docker security boundary', () => {
  it('enforces every boundary in one long-lived container', async () => {
    const uid = hostUid();
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

    const sandbox = workspace.sandbox as DockerSandbox | undefined;
    if (!sandbox?.getInfo || !sandbox.executeCommand)
      throw new Error('fixture sandbox unavailable');
    const executeCommand = sandbox.executeCommand.bind(sandbox);

    await runProbe('sandbox startup', sandbox, async () => {
      await workspace.init();
      const info = await sandbox.getInfo();
      expect(info?.provider).toBe('docker');
    });

    await runProbe('host user identity', sandbox, async () => {
      const identity = await executeCommand('id', ['-u']);
      expect(identity.stdout.trim()).toBe(String(uid));
    });

    await runProbe('writable materialized workspace', sandbox, async () => {
      const result = await executeCommand('sh', [
        '-c',
        'mkdir -p generated/nested && printf ok > generated/nested/result.txt',
      ]);
      expect(result.success).toBe(true);
      expect(await readFile(join(workspaceRoot, 'generated/nested/result.txt'), 'utf8')).toBe('ok');
    });

    await runProbe('read-only root with writable tmpfs', sandbox, async () => {
      const result = await executeCommand('sh', [
        '-c',
        'test ! -w /usr && touch /tmp/triage-write-test',
      ]);
      expect(result.success).toBe(true);
    });

    await runProbe('literal command boundary', sandbox, async () => {
      const chainedCommand = await executeCommand('true && false');
      expect(chainedCommand.success).toBe(false);
    });

    await runProbe('separated stdout and stderr', sandbox, async () => {
      const separatedOutput = await executeCommand('sh', [
        '-c',
        'printf stdout-value; printf stderr-value >&2',
      ]);
      expect(separatedOutput.stdout).toBe('stdout-value');
      expect(separatedOutput.stderr).toBe('stderr-value');
    });

    await runProbe('dropped Linux capabilities', sandbox, async () => {
      const result = await executeCommand(
        "awk '/^Cap(Inh|Prm|Eff|Bnd|Amb):/ { print }' /proc/self/status",
      );
      expect(
        result.success,
        JSON.stringify({ exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout }),
      ).toBe(true);
      expect(result.stdout, JSON.stringify({ stdout: result.stdout })).toMatch(/^CapEff:\s*0+$/mu);
    });

    await runProbe('credential and Git metadata isolation', sandbox, async () => {
      const result = await executeCommand(
        'test -z "$GITHUB_TOKEN" && test -z "$OPENAI_API_KEY" && test ! -e .git',
      );
      expect(
        result.success,
        JSON.stringify({ exitCode: result.exitCode, stderr: result.stderr }),
      ).toBe(true);
    });

    await runProbe('network egress denial', sandbox, async () => {
      const result = await executeCommand(
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
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('EGRESS_DENIED');
    });

    await runProbe('host filesystem write denial', sandbox, async () => {
      const result = await executeCommand(
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
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('HOST_WRITE_DENIED');
      await expect(stat(outsideMarker)).rejects.toThrow();
    });

    await runProbe('prepared dependency read-only mount', sandbox, async () => {
      const result = await executeCommand('node', [
        '-e',
        [
          "const fs = require('node:fs');",
          "if (fs.readFileSync(process.argv[1], 'utf8') !== 'prepared\\n') process.exit(7);",
          "try { fs.writeFileSync(process.argv[1], 'changed'); process.exit(8); }",
          "catch { console.log('PREPARED_READ_ONLY'); }",
        ].join(' '),
        preparedFile,
      ]);
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('PREPARED_READ_ONLY');
      expect(await readFile(preparedFile, 'utf8')).toBe('prepared\n');
    });

    await runProbe('output ceiling preserves container liveness', sandbox, async () => {
      await expect(executeCommand('yes')).rejects.toThrow('WORKSPACE_OUTPUT_LIMIT');
      await expect(executeCommand('true')).resolves.toMatchObject({ success: true });
    });
  }, 30_000);
});
