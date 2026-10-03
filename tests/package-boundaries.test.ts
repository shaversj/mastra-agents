import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { preProcessFile } from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: unknown;
}

const fixtureRoots: string[] = [];

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest;
}

async function childDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function sourceFiles(path: string): Promise<string[]> {
  const files: string[] = [];

  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.mastra') {
      continue;
    }

    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(entryPath)));
    } else if (/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

function requestedExport(packageName: string, specifier: string): string {
  return specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`;
}

function exportsEntry(manifestExports: unknown, requested: string): boolean {
  if (typeof manifestExports === 'string' || Array.isArray(manifestExports)) {
    return requested === '.';
  }

  if (typeof manifestExports !== 'object' || manifestExports === null) {
    return false;
  }

  const keys = Object.keys(manifestExports);
  if (!keys.some((key) => key.startsWith('.'))) {
    return requested === '.';
  }

  return keys.some((key) => {
    if (key === requested) {
      return true;
    }

    const wildcardIndex = key.indexOf('*');
    if (wildcardIndex === -1) {
      return false;
    }

    return (
      requested.startsWith(key.slice(0, wildcardIndex)) &&
      requested.endsWith(key.slice(wildcardIndex + 1))
    );
  });
}

async function packageBoundaryViolations(workspaceRoot: string): Promise<string[]> {
  const appRoots = await childDirectories(join(workspaceRoot, 'apps'));
  const packageRoots = await childDirectories(join(workspaceRoot, 'packages'));
  const workspaceApps = await Promise.all(
    appRoots.map(async (appRoot) => ({
      appRoot,
      manifest: await readManifest(join(appRoot, 'package.json')),
    })),
  );
  const workspacePackages = await Promise.all(
    packageRoots.map(async (packageRoot) => ({
      packageRoot,
      manifest: await readManifest(join(packageRoot, 'package.json')),
    })),
  );
  const violations: string[] = [];

  for (const { appRoot, manifest: appManifest } of workspaceApps) {
    const declaredDependencies = {
      ...appManifest.dependencies,
      ...appManifest.devDependencies,
      ...appManifest.optionalDependencies,
      ...appManifest.peerDependencies,
    };

    for (const sourcePath of await sourceFiles(appRoot)) {
      const source = await readFile(sourcePath, 'utf8');
      const importSpecifiers = preProcessFile(source, true, true).importedFiles.map(
        ({ fileName }) => fileName,
      );

      for (const specifier of importSpecifiers) {
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(sourcePath), specifier);
          const owningApp = appRoots.find(
            (candidate) => target === candidate || target.startsWith(`${candidate}${sep}`),
          );

          if (owningApp && owningApp !== appRoot) {
            violations.push(
              `${relative(workspaceRoot, sourcePath)} imports sibling app source via ${specifier}`,
            );
          }

          const owningPackage = packageRoots.find(
            (candidate) => target === candidate || target.startsWith(`${candidate}${sep}`),
          );
          if (owningPackage) {
            violations.push(
              `${relative(workspaceRoot, sourcePath)} imports workspace package source via ${specifier}; use its public package export`,
            );
          }

          continue;
        }

        const siblingApp = workspaceApps.find(
          ({ appRoot: candidateRoot, manifest }) =>
            candidateRoot !== appRoot &&
            manifest.name !== undefined &&
            (specifier === manifest.name || specifier.startsWith(`${manifest.name}/`)),
        );
        if (siblingApp?.manifest.name) {
          violations.push(
            `${relative(workspaceRoot, sourcePath)} imports sibling app package ${siblingApp.manifest.name}`,
          );
          continue;
        }

        const workspacePackage = workspacePackages
          .filter(({ manifest }) => manifest.name)
          .sort(
            (left, right) => (right.manifest.name?.length ?? 0) - (left.manifest.name?.length ?? 0),
          )
          .find(
            ({ manifest }) =>
              specifier === manifest.name || specifier.startsWith(`${manifest.name}/`),
          );

        if (!workspacePackage?.manifest.name) {
          continue;
        }

        if (!(workspacePackage.manifest.name in declaredDependencies)) {
          violations.push(
            `${relative(workspaceRoot, sourcePath)} imports undeclared workspace dependency ${workspacePackage.manifest.name}`,
          );
          continue;
        }

        const exportPath = requestedExport(workspacePackage.manifest.name, specifier);
        if (!exportsEntry(workspacePackage.manifest.exports, exportPath)) {
          violations.push(
            `${relative(workspaceRoot, sourcePath)} imports unexported workspace entry ${specifier}`,
          );
        }
      }
    }
  }

  return violations.sort();
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mastra-package-boundaries-'));
  fixtureRoots.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('package boundaries', () => {
  it('keeps the actual applications isolated', async () => {
    const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));

    await expect(packageBoundaryViolations(workspaceRoot)).resolves.toEqual([]);
  });

  it('rejects a relative import into a sibling application', async () => {
    const root = await createFixture();
    await writeJson(join(root, 'apps/researcher-agent/package.json'), {
      name: '@fixture/researcher-agent',
    });
    await writeJson(join(root, 'apps/writer-agent/package.json'), {
      name: '@fixture/writer-agent',
    });
    await mkdir(join(root, 'apps/researcher-agent/src'), { recursive: true });
    await mkdir(join(root, 'apps/writer-agent/src'), { recursive: true });
    await writeFile(join(root, 'apps/researcher-agent/src/index.ts'), 'export const value = 1;\n');
    await writeFile(
      join(root, 'apps/writer-agent/src/index.ts'),
      "import { value } from '../../researcher-agent/src/index.js';\nvoid value;\n",
    );

    await expect(packageBoundaryViolations(root)).resolves.toEqual([
      'apps/writer-agent/src/index.ts imports sibling app source via ../../researcher-agent/src/index.js',
    ]);

    await writeFile(
      join(root, 'apps/writer-agent/src/index.ts'),
      "import '@fixture/researcher-agent';\n",
    );

    await expect(packageBoundaryViolations(root)).resolves.toEqual([
      'apps/writer-agent/src/index.ts imports sibling app package @fixture/researcher-agent',
    ]);
  });

  it('accepts a workspace import only with a declaration and public export', async () => {
    const root = await createFixture();
    const appManifestPath = join(root, 'apps/writer-agent/package.json');
    const packageManifestPath = join(root, 'packages/writing-kit/package.json');
    await writeJson(appManifestPath, { name: '@fixture/writer-agent' });
    await writeJson(packageManifestPath, {
      name: '@fixture/writing-kit',
      exports: { './format': './src/format.ts' },
    });
    await mkdir(join(root, 'apps/writer-agent/src'), { recursive: true });
    await writeFile(
      join(root, 'apps/writer-agent/src/index.ts'),
      "import { format } from '@fixture/writing-kit/format';\nvoid format;\n",
    );

    await expect(packageBoundaryViolations(root)).resolves.toEqual([
      'apps/writer-agent/src/index.ts imports undeclared workspace dependency @fixture/writing-kit',
    ]);

    await writeJson(appManifestPath, {
      name: '@fixture/writer-agent',
      dependencies: { '@fixture/writing-kit': 'workspace:*' },
    });
    await writeJson(packageManifestPath, {
      name: '@fixture/writing-kit',
      exports: { '.': './src/index.ts' },
    });

    await expect(packageBoundaryViolations(root)).resolves.toEqual([
      'apps/writer-agent/src/index.ts imports unexported workspace entry @fixture/writing-kit/format',
    ]);

    await writeJson(packageManifestPath, {
      name: '@fixture/writing-kit',
      exports: { './format': './src/format.ts' },
    });

    await expect(packageBoundaryViolations(root)).resolves.toEqual([]);
  });
});
