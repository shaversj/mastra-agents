import { execFile } from 'node:child_process';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { basename, join, posix, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

interface WorkspacePackage {
  dependencies: string[];
  directory: string;
  kind: 'app' | 'shared';
  name: string;
}

export interface WorkspaceSnapshot {
  importers: Record<string, unknown> | null;
  lockfileError: string | null;
  packages: WorkspacePackage[];
}

interface MatrixEntry {
  app: string;
  packageName: string;
  path: string;
}

export interface SelectionResult {
  count: number;
  matrix: { include: MatrixEntry[] };
  reasons: Record<string, string[]>;
  summary: string;
}

export interface SelectionInput {
  after: WorkspaceSnapshot;
  before?: WorkspaceSnapshot;
  changes: string[];
  fallbackReason?: string;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const allZeroRevision = /^0+$/;
const packageManifestPattern = /^(apps|packages)\/([^/]+)\/package\.json$/;
const globalBuildInputs = new Set([
  '.dockerignore',
  '.gitignore',
  '.node-version',
  'eslint.config.js',
  'package.json',
  'pnpm-workspace.yaml',
  'prettier.config.mjs',
  'tsconfig.base.json',
  'vitest.workspace.ts',
]);

function normalizePath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//, '');
}

function dependenciesFromManifest(manifest: PackageManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ].sort();
}

function parseManifest(directory: string, contents: string): WorkspacePackage {
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(contents) as PackageManifest;
  } catch (error) {
    throw new Error(
      `Unable to parse ${directory}/package.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error(`${directory}/package.json must declare a package name`);
  }

  return {
    dependencies: dependenciesFromManifest(manifest),
    directory,
    kind: directory.startsWith('apps/') ? 'app' : 'shared',
    name: manifest.name,
  };
}

function parseLockfile(contents: string): {
  importers: Record<string, unknown> | null;
  lockfileError: string | null;
} {
  try {
    const lockfile: unknown = parseYaml(contents);
    if (
      typeof lockfile !== 'object' ||
      lockfile === null ||
      !('importers' in lockfile) ||
      typeof lockfile.importers !== 'object' ||
      lockfile.importers === null ||
      Array.isArray(lockfile.importers)
    ) {
      return { importers: null, lockfileError: 'pnpm-lock.yaml has no importer map' };
    }
    return { importers: lockfile.importers as Record<string, unknown>, lockfileError: null };
  } catch (error) {
    return {
      importers: null,
      lockfileError: `pnpm-lock.yaml could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readPackageDirectories(
  root: string,
  parent: 'apps' | 'packages',
): Promise<string[]> {
  try {
    const entries = await readdir(join(root, parent), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function loadWorkspaceSnapshot(root: string): Promise<WorkspaceSnapshot> {
  const directories = (
    await Promise.all([
      readPackageDirectories(root, 'apps'),
      readPackageDirectories(root, 'packages'),
    ])
  ).flat();
  const packages = await Promise.all(
    directories.map(async (directory) =>
      parseManifest(directory, await readFile(join(root, directory, 'package.json'), 'utf8')),
    ),
  );

  let lockfile: ReturnType<typeof parseLockfile>;
  try {
    lockfile = parseLockfile(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    lockfile = { importers: null, lockfileError: 'pnpm-lock.yaml is missing' };
  }

  return {
    ...lockfile,
    packages: packages.sort((left, right) => left.directory.localeCompare(right.directory)),
  };
}

function importerChanged(before: unknown, after: unknown): boolean {
  return !isDeepStrictEqual(before, after);
}

function isDocumentationPath(path: string): boolean {
  return (
    path === 'README.md' ||
    path.startsWith('docs/') ||
    path === '.github/pull_request_template.md' ||
    path.endsWith('.md')
  );
}

function isGlobalBuildInput(path: string): boolean {
  return (
    globalBuildInputs.has(path) ||
    path.startsWith('.github/workflows/') ||
    path.startsWith('scripts/') ||
    path.startsWith('tests/')
  );
}

function currentApps(snapshot: WorkspaceSnapshot): WorkspacePackage[] {
  return snapshot.packages.filter(({ kind }) => kind === 'app');
}

function combinedPackages(before: WorkspaceSnapshot | undefined, after: WorkspaceSnapshot) {
  const packagesByName = new Map<string, WorkspacePackage[]>();
  for (const workspacePackage of [...(before?.packages ?? []), ...after.packages]) {
    const versions = packagesByName.get(workspacePackage.name) ?? [];
    versions.push(workspacePackage);
    packagesByName.set(workspacePackage.name, versions);
  }
  return packagesByName;
}

function createDependentAppsResolver(
  before: WorkspaceSnapshot | undefined,
  after: WorkspaceSnapshot,
): (packageName: string) => WorkspacePackage[] {
  const packagesByName = combinedPackages(before, after);
  const reverseDependencies = new Map<string, Set<string>>();

  for (const versions of packagesByName.values()) {
    for (const workspacePackage of versions) {
      for (const dependency of workspacePackage.dependencies) {
        if (!packagesByName.has(dependency)) {
          continue;
        }
        const dependents = reverseDependencies.get(dependency) ?? new Set<string>();
        dependents.add(workspacePackage.name);
        reverseDependencies.set(dependency, dependents);
      }
    }
  }

  const currentAppsByName = new Map(
    currentApps(after).map((workspacePackage) => [workspacePackage.name, workspacePackage]),
  );
  const cache = new Map<string, WorkspacePackage[]>();

  return (packageName) => {
    const cached = cache.get(packageName);
    if (cached) {
      return cached;
    }

    const selected = new Map<string, WorkspacePackage>();
    const visited = new Set([packageName]);
    const queue = [packageName];

    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current) {
        continue;
      }
      for (const dependent of reverseDependencies.get(current) ?? []) {
        if (visited.has(dependent)) {
          continue;
        }
        visited.add(dependent);
        queue.push(dependent);
        const app = currentAppsByName.get(dependent);
        if (app) {
          selected.set(app.name, app);
        }
      }
    }

    const apps = [...selected.values()].sort((left, right) =>
      left.directory.localeCompare(right.directory),
    );
    cache.set(packageName, apps);
    return apps;
  };
}

function allAppsResult(after: WorkspaceSnapshot, reason: string): SelectionResult {
  const apps = currentApps(after).sort((left, right) =>
    left.directory.localeCompare(right.directory),
  );
  return {
    count: apps.length,
    matrix: {
      include: apps.map((app) => ({
        app: basename(app.directory),
        packageName: app.name,
        path: app.directory,
      })),
    },
    reasons: Object.fromEntries(apps.map((app) => [basename(app.directory), [reason]])),
    summary: `Selected all current apps: ${reason}`,
  };
}

export function selectAffectedApps(input: SelectionInput): SelectionResult {
  if (!input.before || input.fallbackReason) {
    return allAppsResult(input.after, input.fallbackReason ?? 'comparison base is unavailable');
  }

  const selected = new Map<string, WorkspacePackage>();
  const reasons = new Map<string, Set<string>>();
  const omissions = new Set<string>();
  const packagesByDirectory = new Map(
    [...input.before.packages, ...input.after.packages].map((workspacePackage) => [
      workspacePackage.directory,
      workspacePackage,
    ]),
  );
  const currentPackagesByDirectory = new Map(
    input.after.packages.map((workspacePackage) => [workspacePackage.directory, workspacePackage]),
  );

  const addApp = (app: WorkspacePackage, reason: string) => {
    selected.set(app.directory, app);
    const appReasons = reasons.get(app.directory) ?? new Set<string>();
    appReasons.add(reason);
    reasons.set(app.directory, appReasons);
  };
  let resolveDependentApps: ((packageName: string) => WorkspacePackage[]) | undefined;
  const addDependents = (workspacePackage: WorkspacePackage, reason: string) => {
    resolveDependentApps ??= createDependentAppsResolver(input.before, input.after);
    for (const app of resolveDependentApps(workspacePackage.name)) {
      addApp(app, `${reason}: ${workspacePackage.name}`);
    }
  };

  const normalizedChanges = input.changes.map(normalizePath);
  const lockfileChanged = normalizedChanges.includes('pnpm-lock.yaml');

  if (lockfileChanged) {
    if (
      input.before.lockfileError ||
      input.after.lockfileError ||
      !input.before.importers ||
      !input.after.importers
    ) {
      return allAppsResult(
        input.after,
        input.before.lockfileError ??
          input.after.lockfileError ??
          'lockfile importer impact is unavailable',
      );
    }

    const importerNames = new Set([
      ...Object.keys(input.before.importers),
      ...Object.keys(input.after.importers),
    ]);
    const changedImporters = [...importerNames]
      .filter((importer) =>
        importerChanged(input.before?.importers?.[importer], input.after.importers?.[importer]),
      )
      .sort();

    if (changedImporters.length === 0) {
      return allAppsResult(input.after, 'lockfile changed without a conclusive importer change');
    }

    for (const importer of changedImporters) {
      if (importer === '.') {
        return allAppsResult(input.after, 'root lockfile importer changed');
      }
      const workspacePackage = packagesByDirectory.get(importer);
      if (!workspacePackage) {
        return allAppsResult(input.after, `unknown lockfile importer changed: ${importer}`);
      }
      if (workspacePackage.kind === 'app') {
        const currentApp = currentPackagesByDirectory.get(importer);
        if (currentApp?.kind === 'app') {
          addApp(currentApp, `lockfile importer changed: ${importer}`);
        } else {
          omissions.add(`deleted app omitted: ${importer}`);
        }
      } else {
        addDependents(workspacePackage, 'shared lockfile importer changed');
      }
    }
  }

  for (const path of normalizedChanges) {
    if (path === 'pnpm-lock.yaml') {
      continue;
    }
    if (isGlobalBuildInput(path)) {
      return allAppsResult(input.after, `global build input changed: ${path}`);
    }

    const segments = path.split('/');
    if ((segments[0] === 'apps' || segments[0] === 'packages') && segments[1]) {
      const directory = `${segments[0]}/${segments[1]}`;
      const workspacePackage = packagesByDirectory.get(directory);
      if (!workspacePackage) {
        return allAppsResult(input.after, `unknown workspace path changed: ${path}`);
      }
      if (workspacePackage.kind === 'app') {
        const currentApp = currentPackagesByDirectory.get(directory);
        if (currentApp?.kind === 'app') {
          addApp(currentApp, `app-owned path changed: ${path}`);
        } else {
          omissions.add(`deleted app omitted: ${directory}`);
        }
      } else {
        addDependents(workspacePackage, 'shared package changed');
      }
      continue;
    }
    if (isDocumentationPath(path)) {
      continue;
    }

    return allAppsResult(input.after, `unknown path changed: ${path}`);
  }

  const apps = [...selected.values()].sort((left, right) =>
    left.directory.localeCompare(right.directory),
  );
  const reasonRecord = Object.fromEntries(
    apps.map((app) => [basename(app.directory), [...(reasons.get(app.directory) ?? [])].sort()]),
  );
  const onlyDocumentation =
    normalizedChanges.length > 0 &&
    normalizedChanges.every(
      (path) =>
        isDocumentationPath(path) &&
        !isGlobalBuildInput(path) &&
        !path.startsWith('apps/') &&
        !path.startsWith('packages/'),
    );
  let summary = 'No current application is affected.';
  if (apps.length > 0) {
    summary = `Selected ${String(apps.length)} affected app${apps.length === 1 ? '' : 's'}.`;
  } else if (onlyDocumentation) {
    summary = 'Documentation-only change; no app validation is required.';
  } else if (omissions.size > 0) {
    summary = `No current application is affected; ${[...omissions].sort().join('; ')}.`;
  }

  return {
    count: apps.length,
    matrix: {
      include: apps.map((app) => ({
        app: basename(app.directory),
        packageName: app.name,
        path: app.directory,
      })),
    },
    reasons: reasonRecord,
    summary,
  };
}

async function runGit(arguments_: string[]): Promise<string> {
  const result = await execFileAsync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

async function revisionExists(revision: string): Promise<boolean> {
  try {
    await runGit(['cat-file', '-e', `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function loadGitSnapshot(revision: string): Promise<WorkspaceSnapshot> {
  const paths = (
    await runGit(['ls-tree', '-r', '--name-only', '-z', revision, '--', 'apps', 'packages'])
  )
    .split('\0')
    .filter((path) => packageManifestPattern.test(path))
    .sort();
  const packages = await Promise.all(
    paths.map(async (path) => {
      const match = packageManifestPattern.exec(path);
      if (!match) {
        throw new Error(`Unexpected workspace manifest path: ${path}`);
      }
      return parseManifest(
        `${match[1]}/${match[2]}`,
        await runGit(['show', `${revision}:${path}`]),
      );
    }),
  );

  let lockfile: ReturnType<typeof parseLockfile>;
  try {
    lockfile = parseLockfile(await runGit(['show', `${revision}:pnpm-lock.yaml`]));
  } catch {
    lockfile = { importers: null, lockfileError: 'pnpm-lock.yaml is missing from the revision' };
  }
  return { ...lockfile, packages };
}

function parseNameStatus(output: string): string[] {
  const entries = output.split('\0');
  const changes: string[] = [];
  for (let index = 0; index < entries.length - 1; index += 2) {
    const rawStatus = entries[index] ?? '';
    const path = entries[index + 1] ?? '';
    const status = rawStatus.slice(0, 1);
    if (!path || (status !== 'A' && status !== 'D' && status !== 'M')) {
      throw new Error(`Git returned an unsupported change entry: ${rawStatus} ${path}`);
    }
    changes.push(path);
  }
  return changes;
}

function parseArguments(arguments_: string[]): {
  base: string;
  githubOutput?: string;
  head: string;
} {
  let base: string | undefined;
  let head: string | undefined;
  let githubOutput: string | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (
      (argument === '--base' || argument === '--head' || argument === '--github-output') &&
      value
    ) {
      if (argument === '--base') base = value;
      if (argument === '--head') head = value;
      if (argument === '--github-output') githubOutput = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${argument ?? ''}`);
  }

  if (!base || !head) {
    throw new Error(
      'Usage: affected-apps --base <revision> --head <revision> [--github-output <path>]',
    );
  }
  if (!/^[a-f0-9]{40}$/i.test(base) || !/^[a-f0-9]{40}$/i.test(head)) {
    throw new Error('Base and head revisions must be full 40-character Git object IDs');
  }
  return githubOutput ? { base, githubOutput, head } : { base, head };
}

async function selectFromGit(base: string, head: string): Promise<SelectionResult> {
  if (!(await revisionExists(head))) {
    throw new Error(`Head revision is unavailable: ${head}`);
  }
  const after = await loadGitSnapshot(head);
  if (allZeroRevision.test(base) || !(await revisionExists(base))) {
    return selectAffectedApps({
      after,
      changes: [],
      fallbackReason: allZeroRevision.test(base)
        ? 'comparison base is the all-zero revision'
        : `comparison base is unavailable: ${base}`,
    });
  }

  try {
    const changes = parseNameStatus(
      await runGit(['diff', '--name-status', '-z', '--no-renames', base, head, '--']),
    );
    const before = await loadGitSnapshot(base);
    return selectAffectedApps({ after, before, changes });
  } catch (error) {
    return selectAffectedApps({
      after,
      changes: [],
      fallbackReason: `comparison could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const result = await selectFromGit(options.base, options.head);
  const matrix = JSON.stringify(result.matrix);

  console.error(result.summary);
  for (const entry of result.matrix.include) {
    console.error(`- ${entry.app}: ${(result.reasons[entry.app] ?? []).join('; ')}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);

  if (options.githubOutput) {
    await appendFile(
      options.githubOutput,
      `matrix=${matrix}\ncount=${String(result.count)}\n`,
      'utf8',
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
