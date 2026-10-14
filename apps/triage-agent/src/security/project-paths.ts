import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function relativeSegments(configuredPath: string): string[] | undefined {
  if (
    !configuredPath ||
    isAbsolute(configuredPath) ||
    configuredPath.includes('\\') ||
    /^[A-Za-z]:/u.test(configuredPath)
  ) {
    return undefined;
  }
  const segments = configuredPath.split('/');
  return segments.some((segment) => !segment || segment === '.' || segment === '..')
    ? undefined
    : segments;
}

export async function resolveProjectSkillFile(
  repositoryRoot: string,
  configuredPath: string,
): Promise<string | undefined> {
  const segments = relativeSegments(configuredPath);
  if (!segments) return undefined;
  const canonicalRoot = await realpath(repositoryRoot).catch(() => undefined);
  if (!canonicalRoot) return undefined;
  let candidate = canonicalRoot;
  for (const [index, segment] of [...segments, 'SKILL.md'].entries()) {
    candidate = resolve(candidate, segment);
    if (!isContained(canonicalRoot, candidate)) return undefined;
    const metadata = await lstat(candidate).catch(() => undefined);
    if (!metadata || metadata.isSymbolicLink()) return undefined;
    const isSkillFile = index === segments.length;
    if (isSkillFile ? !metadata.isFile() : !metadata.isDirectory()) return undefined;
  }

  const canonicalCandidate = await realpath(candidate).catch(() => undefined);
  return canonicalCandidate && isContained(canonicalRoot, canonicalCandidate)
    ? canonicalCandidate
    : undefined;
}

export async function resolvePreparedDependencyPath(
  repositoryRoot: string,
  configuredPath: string,
): Promise<string | undefined> {
  const segments = relativeSegments(configuredPath);
  if (!segments) return undefined;
  const canonicalRoot = await realpath(repositoryRoot).catch(() => undefined);
  if (!canonicalRoot) return undefined;
  let candidate = canonicalRoot;
  for (const segment of segments) {
    candidate = resolve(candidate, segment);
    if (!isContained(canonicalRoot, candidate)) return undefined;
    const metadata = await lstat(candidate).catch(() => undefined);
    if (!metadata || metadata.isSymbolicLink()) return undefined;
  }
  const finalMetadata = await lstat(candidate).catch(() => undefined);
  if (!finalMetadata?.isDirectory()) return undefined;
  const canonicalCandidate = await realpath(candidate).catch(() => undefined);
  return canonicalCandidate && isContained(canonicalRoot, canonicalCandidate)
    ? canonicalCandidate
    : undefined;
}
