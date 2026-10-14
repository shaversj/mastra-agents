import { execFile } from 'node:child_process';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  LocalFilesystem,
  LocalSkillSource,
  Workspace,
  WORKSPACE_TOOLS,
  type CommandResult,
  type ExecuteCommandOptions,
  type LocalFilesystemOptions,
  type WorkspaceToolsConfig,
} from '@mastra/core/workspace';
import {
  DockerSandbox,
  type DockerSandboxOptions,
  type DockerSandboxStartOptions,
} from '@mastra/docker';

import {
  assertCredentialFreeContent,
  assertWorkspaceCeilings,
  assertWorkspaceUsageCeilings,
  defaultDiffLimits,
  measureWorkspaceUsage,
  type DiffLimits,
  type WorkspaceSnapshot,
} from './diff-policy.js';
import {
  assertSafeGitEnvironment,
  secureGitEnvironment,
  trustedExecutableDirectories,
} from './git-environment.js';

export interface CommandLimits {
  addressSpaceKiB: number;
  cpuSeconds: number;
  fileSizeBlocks: number;
  maxCommands: number;
  maxElapsedMs: number;
  maxOpenFiles: number;
  maxOutputBytes: number;
  maxProcesses: number;
  timeoutMs: number;
}

export const defaultCommandLimits: CommandLimits = {
  addressSpaceKiB: 1024 * 1024,
  cpuSeconds: 120,
  fileSizeBlocks: 32 * 1024,
  maxCommands: 40,
  maxElapsedMs: 15 * 60 * 1000,
  maxOpenFiles: 256,
  maxOutputBytes: 128 * 1024,
  maxProcesses: 64,
  timeoutMs: 120_000,
};

export const triageSandboxImage =
  'node:22.13.0-bookworm-slim@sha256:f5a0871ab03b035c58bdb3007c3d177b001c2145c18e81817b71624dcf7d8bff';

export type SandboxFactoryOptions = DockerSandboxOptions & {
  commandLimits: CommandLimits;
  diffLimits: DiffLimits;
  hostWorkspaceRoot: string;
  sandboxUser: string;
};

export interface WorkspaceFactoryOptions {
  filesystem: unknown;
  sandbox: unknown;
  skillSource: unknown;
  skills: string[];
  tools: WorkspaceToolsConfig;
}

export interface WorkspaceFactories<TWorkspace = unknown> {
  createFilesystem(options: LocalFilesystemOptions): unknown;
  createSandbox(options: SandboxFactoryOptions): unknown;
  createSkillSource(options: { basePath: string }): unknown;
  createWorkspace(options: WorkspaceFactoryOptions): TWorkspace;
}

export interface PreparedPath {
  source: string;
  target: string;
}

export interface MaterializedWorkspace<TWorkspace = Workspace> {
  baseline: WorkspaceSnapshot;
  cleanup(): Promise<void>;
  materializationRoot: string;
  preparedReadOnlyPaths: string[];
  workspace: TWorkspace;
  workspaceRoot: string;
}

export interface SandboxCommandEvidence {
  kind: 'command' | 'test';
  status: 'failed' | 'passed';
}

type SecureWorkspaceLifecycle = {
  destroy?: () => Promise<unknown>;
  init?: () => Promise<unknown>;
  sandbox:
    | {
        executeCommand?: (
          command: string,
          args?: string[],
          options?: ExecuteCommandOptions,
        ) => Promise<CommandResult>;
        drainCommandEvidence?: () => SandboxCommandEvidence[];
      }
    | undefined;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertContainedRelativePath(path: string, code: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\0') ||
    path.split(/[\\/]/u).some((part) => !part || part === '..')
  ) {
    throw new Error(code);
  }
}

async function assertRegularTree(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata) throw new Error('WORKSPACE_PREREQUISITE_MISSING');
  if (metadata.isSymbolicLink()) throw new Error('WORKSPACE_PREREQUISITE_SYMLINK');
  if (metadata.isFile()) return;
  if (!metadata.isDirectory()) throw new Error('WORKSPACE_PREREQUISITE_SPECIAL_FILE');
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(path)) await assertRegularTree(join(path, entry));
}

async function assertPreparedTreeCredentialFree(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isDirectory()) {
    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(path)) {
      await assertPreparedTreeCredentialFree(join(path, entry));
    }
    return;
  }
  const name = basename(path).toLowerCase();
  if (
    name === '.env' ||
    name.startsWith('.env.') ||
    ['.gitconfig', '.netrc', '.npmrc', '.pypirc', '.yarnrc', '.yarnrc.yml'].includes(name)
  ) {
    throw new Error('WORKSPACE_PREPARED_CREDENTIAL_FILE');
  }
  if (metadata.size > defaultDiffLimits.maxFileBytes) {
    throw new Error('WORKSPACE_PREPARED_FILE_TOO_LARGE');
  }
  assertCredentialFreeContent(await readFile(path), 'WORKSPACE_PREPARED_CREDENTIAL_CONTENT');
}

function boundedCommand(command: string, args: string[], limits: CommandLimits): string {
  const invocation = args.length
    ? `${shellQuote(command)} ${args.map((argument) => shellQuote(argument)).join(' ')}`
    : command;
  const retainedOutputBytes = limits.maxOutputBytes + 1;
  const outputBoundedInvocation = [
    'output_dir=$(mktemp -d /tmp/triage-output.XXXXXX) || exit 125',
    'trap \'rm -rf -- "$output_dir"\' EXIT HUP INT TERM',
    'mkfifo "$output_dir/stdout" "$output_dir/stderr" || exit 125',
    `head -c ${retainedOutputBytes} < "$output_dir/stdout" & stdout_pid=$!`,
    `head -c ${retainedOutputBytes} < "$output_dir/stderr" >&2 & stderr_pid=$!`,
    `/bin/bash -c ${shellQuote(invocation)} > "$output_dir/stdout" 2> "$output_dir/stderr"`,
    'command_status=$?',
    'wait "$stdout_pid"',
    'wait "$stderr_pid"',
    'exit "$command_status"',
  ].join('; ');
  const boundedInvocation = [
    `ulimit -t ${limits.cpuSeconds}`,
    `ulimit -v ${limits.addressSpaceKiB}`,
    `ulimit -n ${limits.maxOpenFiles}`,
    `ulimit -f ${limits.fileSizeBlocks}`,
    `exec /bin/bash -c ${shellQuote(outputBoundedInvocation)}`,
  ].join('; ');
  return `exec /bin/bash -c ${shellQuote(boundedInvocation)}`;
}

class BoundedDockerSandbox extends DockerSandbox {
  private readonly commandEvidence: SandboxCommandEvidence[] = [];
  private commandCount = 0;
  private readonly commandLimits: CommandLimits;
  private readonly deadline: number;
  private readonly diffLimits: DiffLimits;
  private readonly hostWorkspaceRoot: string;
  private readonly sandboxUser: string;

  constructor(options: SandboxFactoryOptions) {
    const { commandLimits, diffLimits, hostWorkspaceRoot, sandboxUser, ...sandboxOptions } =
      options;
    super(sandboxOptions);
    this.commandLimits = commandLimits;
    this.diffLimits = diffLimits;
    this.hostWorkspaceRoot = hostWorkspaceRoot;
    this.sandboxUser = sandboxUser;
    this.deadline = Date.now() + commandLimits.maxElapsedMs;

    // @mastra/docker does not yet expose Docker's Config.User. Keep the provider's
    // lifecycle while injecting the host identity at the container boundary so a
    // capability-free process can access the owner-only materialized workspace.
    const docker = (
      this as unknown as {
        _docker: {
          createContainer(options: Record<string, unknown>): Promise<unknown>;
        };
      }
    )._docker;
    const createContainer = docker.createContainer.bind(docker);
    docker.createContainer = (containerOptions) =>
      createContainer({ ...containerOptions, User: sandboxUser });
  }

  override async start(options: DockerSandboxStartOptions = {}): Promise<void> {
    await super.start(options);
    const info = await this.container.inspect();
    if (info.Config?.User === this.sandboxUser) return;
    await super.destroy().catch(() => undefined);
    throw new Error('SANDBOX_USER_MISMATCH');
  }

  drainCommandEvidence(): SandboxCommandEvidence[] {
    return this.commandEvidence.splice(0);
  }

  override async executeCommand(
    command: string,
    args: string[] = [],
    options: ExecuteCommandOptions = {},
  ): Promise<CommandResult> {
    const kind = /(?:^|[\/ -])(?:test|spec|check)(?:$|[ /-])/iu.test(`${command} ${args.join(' ')}`)
      ? 'test'
      : 'command';
    this.commandCount += 1;
    if (this.commandCount > this.commandLimits.maxCommands) {
      throw new Error('WORKSPACE_COMMAND_LIMIT');
    }
    const remainingMs = this.deadline - Date.now();
    if (remainingMs <= 0) throw new Error('WORKSPACE_ELAPSED_LIMIT');
    if (options.env && Object.keys(options.env).length > 0)
      throw new Error('WORKSPACE_ENV_OVERRIDE');
    if (options.cwd) {
      const requested = resolve(this.workingDirectory, options.cwd);
      const relativePath = relative(this.workingDirectory, requested);
      if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
        throw new Error('WORKSPACE_CWD_ESCAPE');
      }
    }

    let resourceViolation: Error | undefined;
    let outputBytes = 0;
    const countOutput = (data: string) => {
      outputBytes += Buffer.byteLength(data);
      if (outputBytes <= this.commandLimits.maxOutputBytes || resourceViolation) return;
      resourceViolation = new Error('WORKSPACE_OUTPUT_LIMIT');
    };
    const handle = await this.processes.spawn(boundedCommand(command, args, this.commandLimits), {
      ...options,
      env: {},
      maxRetainedBytes: this.commandLimits.maxOutputBytes,
      onStderr: countOutput,
      onStdout: countOutput,
      stdinMode: 'ignore',
      timeout: Math.min(options.timeout ?? this.commandLimits.timeoutMs, remainingMs),
    });
    let watchdogScan: Promise<void> | undefined;
    const scanWorkspace = () => {
      if (watchdogScan || resourceViolation) return;
      watchdogScan = assertWorkspaceUsageCeilings(this.hostWorkspaceRoot, this.diffLimits)
        .then(() => undefined)
        .catch(async (error: unknown) => {
          resourceViolation =
            error instanceof Error ? error : new Error('WORKSPACE_RESOURCE_LIMIT');
          await handle.kill();
        })
        .finally(() => {
          watchdogScan = undefined;
        });
    };
    const watchdog = setInterval(() => {
      scanWorkspace();
    }, 250);
    watchdog.unref();

    try {
      const result = await handle.wait(
        options.abortSignal ? { abortSignal: options.abortSignal } : undefined,
      );
      clearInterval(watchdog);
      await watchdogScan;
      if (resourceViolation) throw resourceViolation;
      await assertWorkspaceUsageCeilings(this.hostWorkspaceRoot, this.diffLimits);
      const redactedResult = { ...result };
      delete redactedResult.args;
      delete redactedResult.command;
      this.commandEvidence.push({ kind, status: result.success ? 'passed' : 'failed' });
      return redactedResult;
    } catch (error) {
      this.commandEvidence.push({ kind, status: 'failed' });
      throw error;
    } finally {
      clearInterval(watchdog);
      await watchdogScan;
      this.processes.release(handle.pid);
    }
  }
}

function dockerDaemonAvailable(): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    execFile(
      'docker',
      ['version', '--format', '{{.Server.Version}}'],
      {
        env: { PATH: trustedExecutableDirectories.join(':') },
        timeout: 5_000,
      },
      (error) => resolveAvailability(!error),
    );
  });
}

export async function assertDockerSandboxAvailable(
  input: { checkDocker?: () => boolean | Promise<boolean> } = {},
): Promise<void> {
  if (!(await (input.checkDocker ?? dockerDaemonAvailable)())) {
    throw new Error('SANDBOX_DOCKER_UNAVAILABLE');
  }
}

function workspaceTools(): WorkspaceToolsConfig {
  const rejectBackgroundCommand = ({ input }: { input: unknown }) => {
    if (
      typeof input === 'object' &&
      input !== null &&
      'background' in input &&
      input.background === true
    ) {
      return { output: { error: 'BACKGROUND_EXECUTION_DISABLED' }, proceed: false as const };
    }
    return undefined;
  };
  return {
    enabled: false,
    hooks: { beforeToolCall: rejectBackgroundCommand },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
      enabled: true,
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: { enabled: true },
    [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { enabled: true, maxOutputTokens: 3000 },
    [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: { enabled: true, maxOutputTokens: 3000 },
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { enabled: true, maxOutputTokens: 4000 },
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      enabled: true,
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      background: { enabled: false },
      enabled: true,
      maxOutputTokens: 4000,
    },
  };
}

function hostSandboxUser(): string {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new Error('SANDBOX_HOST_IDENTITY_UNAVAILABLE');
  }
  return `${process.getuid()}:${process.getgid()}`;
}

const defaultFactories: WorkspaceFactories<Workspace> = {
  createFilesystem: (options) => new LocalFilesystem(options),
  createSandbox: (options) => new BoundedDockerSandbox(options),
  createSkillSource: (options) => new LocalSkillSource(options),
  createWorkspace: (options) =>
    new Workspace({
      filesystem: options.filesystem as LocalFilesystem,
      sandbox: options.sandbox as DockerSandbox,
      skillSource: options.skillSource as LocalSkillSource,
      skills: options.skills,
      tools: options.tools,
    }),
};

export function createSecureWorkspace<TWorkspace = Workspace>(input: {
  commandLimits?: Partial<CommandLimits>;
  diffLimits?: Partial<DiffLimits>;
  factories?: WorkspaceFactories<TWorkspace>;
  preparedReadOnlyPaths?: string[];
  triageSkillPath: string;
  workspaceRoot: string;
}): TWorkspace {
  const commandLimits = { ...defaultCommandLimits, ...input.commandLimits };
  const diffLimits = { ...defaultDiffLimits, ...input.diffLimits };
  if (!isAbsolute(input.workspaceRoot) || !isAbsolute(input.triageSkillPath)) {
    throw new Error('WORKSPACE_ABSOLUTE_PATH_REQUIRED');
  }
  const preparedReadOnlyPaths = input.preparedReadOnlyPaths ?? [];
  if (preparedReadOnlyPaths.some((path) => !isAbsolute(path))) {
    throw new Error('WORKSPACE_PREPARED_PATH_INVALID');
  }

  const factories = input.factories ?? (defaultFactories as WorkspaceFactories<TWorkspace>);
  const filesystem = factories.createFilesystem({
    allowedPaths: [],
    basePath: input.workspaceRoot,
    contained: true,
  });
  const sandbox = factories.createSandbox({
    capDrop: ['ALL'],
    commandLimits,
    diffLimits,
    env: {
      ...secureGitEnvironment(),
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    } as Record<string, string>,
    hostWorkspaceRoot: input.workspaceRoot,
    image: triageSandboxImage,
    memory: commandLimits.addressSpaceKiB * 1024,
    memorySwap: commandLimits.addressSpaceKiB * 1024,
    mounts: [
      {
        readOnly: false,
        source: input.workspaceRoot,
        target: '/workspace',
        type: 'bind',
      },
      ...preparedReadOnlyPaths.map((path) => ({
        readOnly: true,
        source: path,
        target: path,
        type: 'bind' as const,
      })),
    ],
    network: 'none',
    // RLIMIT_NPROC is host-UID-wide on Linux and can prevent container init on shared runners.
    // Docker's PID cgroup keeps this ceiling scoped to the sandbox instead.
    pidsLimit: commandLimits.maxProcesses,
    privileged: false,
    readonlyRootfs: true,
    sandboxUser: hostSandboxUser(),
    securityOpt: ['no-new-privileges:true'],
    timeout: commandLimits.timeoutMs,
    tmpfs: {
      '/tmp': 'rw,noexec,nosuid,nodev,size=67108864',
    },
    ulimits: [
      {
        hard: commandLimits.maxOpenFiles,
        name: 'nofile',
        soft: commandLimits.maxOpenFiles,
      },
    ],
    workingDirectory: '/workspace',
  });
  const skillRoot = dirname(dirname(input.triageSkillPath));
  const skillSource = factories.createSkillSource({ basePath: skillRoot });
  return factories.createWorkspace({
    filesystem,
    sandbox,
    skillSource,
    skills: [`${basename(dirname(input.triageSkillPath))}/${basename(input.triageSkillPath)}`],
    tools: workspaceTools(),
  });
}

async function copySourceFile(
  sourceRoot: string,
  workspaceRoot: string,
  path: string,
): Promise<void> {
  assertContainedRelativePath(path, 'WORKSPACE_SOURCE_PATH_INVALID');
  const source = resolve(sourceRoot, path);
  const sourceRelative = relative(sourceRoot, source);
  if (sourceRelative === '..' || sourceRelative.startsWith(`..${sep}`)) {
    throw new Error('WORKSPACE_SOURCE_PATH_INVALID');
  }
  const metadata = await lstat(source).catch(() => undefined);
  if (!metadata?.isFile()) throw new Error('WORKSPACE_SOURCE_FILE_INVALID');
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const parts = normalized.split('/');
  const sourceBasename = parts.at(-1) ?? '';
  const environmentFile =
    sourceBasename === '.env' ||
    (sourceBasename.startsWith('.env.') &&
      !['.env.example', '.env.sample', '.env.template'].includes(sourceBasename));
  if (
    environmentFile ||
    parts.includes('.git') ||
    parts.includes('.ssh') ||
    ['.gitconfig', '.npmrc', '.pypirc', '.yarnrc', '.yarnrc.yml', '.netrc'].includes(sourceBasename)
  ) {
    throw new Error('WORKSPACE_SOURCE_PROTECTED');
  }
  assertCredentialFreeContent(await readFile(source), 'WORKSPACE_SOURCE_CREDENTIAL');
  const destination = resolve(workspaceRoot, path);
  await mkdir(dirname(destination), { mode: 0o700, recursive: true });
  await cp(source, destination, { errorOnExist: true, force: false, preserveTimestamps: false });
}

async function prepareReadOnlyPath(
  materializationRoot: string,
  workspaceRoot: string,
  prepared: PreparedPath,
): Promise<string> {
  assertContainedRelativePath(prepared.target, 'WORKSPACE_PREPARED_TARGET_INVALID');
  await assertRegularTree(prepared.source);
  await assertPreparedTreeCredentialFree(prepared.source);
  const canonicalSource = await realpath(prepared.source);
  const preparedRoot = join(materializationRoot, 'prepared');
  const destination = join(preparedRoot, prepared.target);
  await mkdir(dirname(destination), { mode: 0o700, recursive: true });
  await cp(canonicalSource, destination, {
    dereference: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
    recursive: true,
  });
  const workspaceTarget = join(workspaceRoot, prepared.target);
  await mkdir(dirname(workspaceTarget), { mode: 0o700, recursive: true });
  await symlink(destination, workspaceTarget);
  return destination;
}

async function assertMaterializationCeilings(
  workspaceRoot: string,
  preparedReadOnlyPaths: string[],
  limits: DiffLimits,
): Promise<WorkspaceSnapshot> {
  const workspaceUsage = await assertWorkspaceCeilings(workspaceRoot, limits);
  let materializedBytes = workspaceUsage.totalBytes;
  let materializedInodes = workspaceUsage.totalInodes;
  for (const preparedPath of preparedReadOnlyPaths) {
    const preparedUsage = await measureWorkspaceUsage(preparedPath);
    materializedBytes += preparedUsage.totalBytes;
    materializedInodes += preparedUsage.totalInodes;
  }
  if (materializedBytes > limits.maxWorkspaceBytes) throw new Error('WORKSPACE_BYTES_EXCEEDED');
  if (materializedInodes > limits.maxWorkspaceInodes) {
    throw new Error('WORKSPACE_INODES_EXCEEDED');
  }
  return workspaceUsage;
}

async function assertSnapshotCredentialFree(
  workspaceRoot: string,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  for (const [path, entry] of Object.entries(snapshot.files)) {
    if (entry.kind !== 'file') continue;
    assertCredentialFreeContent(
      await readFile(join(workspaceRoot, path)),
      'WORKSPACE_CREDENTIAL_CONTENT',
    );
  }
}

export async function createMaterializedWorkspace<
  TWorkspace extends SecureWorkspaceLifecycle = Workspace,
>(input: {
  buildCommand?: string;
  commandLimits?: Partial<CommandLimits>;
  createSecureWorkspace?: (options: {
    commandLimits?: Partial<CommandLimits>;
    diffLimits?: Partial<DiffLimits>;
    preparedReadOnlyPaths: string[];
    triageSkillPath: string;
    workspaceRoot: string;
  }) => TWorkspace;
  diffLimits?: Partial<DiffLimits>;
  environment?: Readonly<Record<string, string | undefined>>;
  preparedPaths?: PreparedPath[];
  sourceFiles: string[];
  sourceRoot: string;
  triageSkillPath: string;
}): Promise<MaterializedWorkspace<TWorkspace>> {
  assertSafeGitEnvironment(input.environment ?? {});
  if (input.sourceFiles.length === 0) throw new Error('WORKSPACE_SOURCE_EMPTY');
  const skillMetadata = await lstat(input.triageSkillPath).catch(() => undefined);
  if (!skillMetadata?.isFile()) throw new Error('WORKSPACE_TRIAGE_SKILL_MISSING');

  const materializationRoot = await mkdtemp(join(tmpdir(), 'mastra-triage-'));
  await chmod(materializationRoot, 0o700);
  const workspaceRoot = join(materializationRoot, 'workspace');
  await mkdir(workspaceRoot, { mode: 0o700 });

  let workspace: TWorkspace | undefined;
  try {
    const canonicalSourceRoot = await realpath(input.sourceRoot);
    for (const path of [...new Set(input.sourceFiles)].sort()) {
      await copySourceFile(canonicalSourceRoot, workspaceRoot, path);
    }
    const preparedReadOnlyPaths: string[] = [];
    for (const prepared of input.preparedPaths ?? []) {
      preparedReadOnlyPaths.push(
        await prepareReadOnlyPath(materializationRoot, workspaceRoot, prepared),
      );
    }

    const materializationLimits = { ...defaultDiffLimits, ...input.diffLimits };
    await assertMaterializationCeilings(
      workspaceRoot,
      preparedReadOnlyPaths,
      materializationLimits,
    );

    const create = input.createSecureWorkspace ?? createSecureWorkspace;
    workspace = create({
      ...(input.commandLimits ? { commandLimits: input.commandLimits } : {}),
      ...(input.diffLimits ? { diffLimits: input.diffLimits } : {}),
      preparedReadOnlyPaths,
      triageSkillPath: input.triageSkillPath,
      workspaceRoot,
    }) as TWorkspace;
    await workspace.init?.();

    if (input.buildCommand) {
      const executeCommand = workspace.sandbox?.executeCommand;
      if (!executeCommand) throw new Error('WORKSPACE_BUILD_UNAVAILABLE');
      const result = await executeCommand.call(workspace.sandbox, input.buildCommand, [], {
        maxRetainedBytes: defaultCommandLimits.maxOutputBytes,
      });
      if (!result.success) throw new Error('WORKSPACE_BUILD_FAILED');
    }
    const baseline = await assertMaterializationCeilings(
      workspaceRoot,
      preparedReadOnlyPaths,
      materializationLimits,
    );
    await assertSnapshotCredentialFree(workspaceRoot, baseline);
    let cleaned = false;
    return {
      baseline,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        try {
          await workspace?.destroy?.();
        } finally {
          await rm(materializationRoot, { force: true, recursive: true });
        }
      },
      materializationRoot,
      preparedReadOnlyPaths,
      workspace,
      workspaceRoot,
    };
  } catch (error) {
    await workspace?.destroy?.().catch(() => undefined);
    await rm(materializationRoot, { force: true, recursive: true });
    throw error;
  }
}
