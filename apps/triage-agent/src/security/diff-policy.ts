import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface DiffLimits {
  maxChangedFiles: number;
  maxDiffBytes: number;
  maxFileBytes: number;
  maxWorkspaceBytes: number;
  maxWorkspaceInodes: number;
}

export const defaultDiffLimits: DiffLimits = {
  maxChangedFiles: 30,
  maxDiffBytes: 512 * 1024,
  maxFileBytes: 256 * 1024,
  maxWorkspaceBytes: 256 * 1024 * 1024,
  maxWorkspaceInodes: 50_000,
};

export interface SnapshotEntry {
  digest: string;
  kind: 'file' | 'symlink';
  size: number;
  target?: string;
}

export interface WorkspaceSnapshot {
  files: Record<string, SnapshotEntry>;
  totalBytes: number;
  totalInodes: number;
}

export interface WorkspaceUsage {
  totalBytes: number;
  totalInodes: number;
}

export interface AdmittedChange {
  kind: 'added' | 'deleted' | 'modified';
  path: string;
}

export interface AdmittedChanges {
  changes: AdmittedChange[];
  files: Record<string, Buffer>;
}

const protectedPrefixes = ['.git', '.github/actions', '.github/workflows'];
const prohibitedControlFiles = new Set([
  '.env',
  '.gitconfig',
  '.gitmodules',
  '.npmrc',
  '.pypirc',
  '.yarnrc',
  '.yarnrc.yml',
]);
const credentialPatterns = [
  /-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/u,
  /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/u,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[opusr]_[A-Za-z0-9]{30,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
];

export function assertCredentialFreeContent(content: Buffer | string, errorCode: string): void {
  const buffer = typeof content === 'string' ? Buffer.from(content) : content;
  const text = buffer.toString('utf8');
  if (credentialPatterns.some((pattern) => pattern.test(text))) throw new Error(errorCode);
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isProtectedPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const parts = normalized.split('/');
  const pathBasename = parts.at(-1) ?? '';
  const environmentFile =
    pathBasename === '.env' ||
    (pathBasename.startsWith('.env.') &&
      !['.env.example', '.env.sample', '.env.template'].includes(pathBasename));
  return (
    protectedPrefixes.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    ) ||
    prohibitedControlFiles.has(pathBasename) ||
    environmentFile ||
    parts.includes('.ssh')
  );
}

function assertRelativePath(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\0') ||
    path.split(/[\\/]/u).some((part) => part === '..' || part === '')
  ) {
    throw new Error('DIFF_PATH_INVALID');
  }
}

async function walk(root: string, directory = ''): Promise<Array<[string, SnapshotEntry]>> {
  const absoluteDirectory = resolve(root, directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files: Array<[string, SnapshotEntry]> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    const absolutePath = resolve(root, path);
    const metadata = await lstat(absolutePath);
    if (metadata.isDirectory()) {
      files.push(...(await walk(root, path)));
      continue;
    }
    if (metadata.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      files.push([
        path,
        {
          digest: digest(Buffer.from(target)),
          kind: 'symlink',
          size: Buffer.byteLength(target),
          target,
        },
      ]);
      continue;
    }
    if (!metadata.isFile()) throw new Error('DIFF_SPECIAL_FILE');
    const content = await readFile(absolutePath);
    files.push([path, { digest: digest(content), kind: 'file', size: content.byteLength }]);
  }
  return files;
}

async function measure(root: string, directory = ''): Promise<WorkspaceUsage> {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  let totalBytes = 0;
  let totalInodes = 0;
  for (const entry of entries) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    const metadata = await lstat(resolve(root, path));
    totalInodes += 1;
    if (metadata.isDirectory()) {
      const nested = await measure(root, path);
      totalBytes += nested.totalBytes;
      totalInodes += nested.totalInodes;
    } else if (metadata.isFile() || metadata.isSymbolicLink()) {
      totalBytes += metadata.size;
    } else {
      throw new Error('DIFF_SPECIAL_FILE');
    }
  }
  return { totalBytes, totalInodes };
}

export async function measureWorkspaceUsage(workspaceRoot: string): Promise<WorkspaceUsage> {
  return measure(await realpath(workspaceRoot));
}

export async function assertWorkspaceUsageCeilings(
  workspaceRoot: string,
  limits: DiffLimits = defaultDiffLimits,
): Promise<WorkspaceUsage> {
  const usage = await measureWorkspaceUsage(workspaceRoot);
  if (usage.totalBytes > limits.maxWorkspaceBytes) throw new Error('WORKSPACE_BYTES_EXCEEDED');
  if (usage.totalInodes > limits.maxWorkspaceInodes) {
    throw new Error('WORKSPACE_INODES_EXCEEDED');
  }
  return usage;
}

export async function snapshotWorkspace(workspaceRoot: string): Promise<WorkspaceSnapshot> {
  const canonicalRoot = await realpath(workspaceRoot);
  const entries = await walk(canonicalRoot);
  return {
    files: Object.fromEntries(entries),
    totalBytes: entries.reduce((total, [, entry]) => total + entry.size, 0),
    totalInodes: entries.length,
  };
}

export async function assertWorkspaceCeilings(
  workspaceRoot: string,
  limits: DiffLimits = defaultDiffLimits,
): Promise<WorkspaceSnapshot> {
  const snapshot = await snapshotWorkspace(workspaceRoot);
  if (snapshot.totalBytes > limits.maxWorkspaceBytes) throw new Error('WORKSPACE_BYTES_EXCEEDED');
  if (snapshot.totalInodes > limits.maxWorkspaceInodes)
    throw new Error('WORKSPACE_INODES_EXCEEDED');
  return snapshot;
}

export async function admitWorkspaceChanges(input: {
  baseline: WorkspaceSnapshot;
  limits?: DiffLimits;
  workspaceRoot: string;
}): Promise<AdmittedChanges> {
  const limits = input.limits ?? defaultDiffLimits;
  const current = await assertWorkspaceCeilings(input.workspaceRoot, limits);
  const paths = [
    ...new Set([...Object.keys(input.baseline.files), ...Object.keys(current.files)]),
  ].sort();
  const changes: AdmittedChange[] = [];

  for (const path of paths) {
    assertRelativePath(path);
    const before = input.baseline.files[path];
    const after = current.files[path];
    if (before?.digest === after?.digest && before?.kind === after?.kind) continue;
    if (isProtectedPath(path)) throw new Error('DIFF_PROTECTED_PATH');
    if ((before && before.kind === 'symlink') || (after && after.kind === 'symlink')) {
      throw new Error('DIFF_SYMLINK');
    }
    changes.push({ kind: before ? (after ? 'modified' : 'deleted') : 'added', path });
  }

  if (changes.length > limits.maxChangedFiles) throw new Error('DIFF_TOO_MANY_FILES');
  const changedBytes = changes.reduce((total, change) => {
    const beforeSize = input.baseline.files[change.path]?.size ?? 0;
    const afterSize = current.files[change.path]?.size ?? 0;
    return total + beforeSize + afterSize;
  }, 0);
  if (changedBytes > limits.maxDiffBytes) throw new Error('DIFF_TOO_LARGE');

  const canonicalRoot = await realpath(input.workspaceRoot);
  const admittedFiles: Record<string, Buffer> = {};
  for (const change of changes) {
    const entry = current.files[change.path];
    if (!entry) continue;
    if (entry.size > limits.maxFileBytes) throw new Error('DIFF_FILE_TOO_LARGE');
    const absolutePath = resolve(canonicalRoot, change.path);
    const relativePath = relative(canonicalRoot, absolutePath);
    if (relativePath.startsWith(`..${sep}`) || relativePath === '..')
      throw new Error('DIFF_PATH_INVALID');
    const content = await readFile(absolutePath);
    if (content.includes(0)) throw new Error('DIFF_BINARY_FILE');
    assertCredentialFreeContent(content, 'DIFF_CREDENTIAL_CONTENT');
    admittedFiles[change.path] = content;
  }

  return { changes, files: admittedFiles };
}
