import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, onTestFinished } from 'vitest';

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
}

async function artifactContractViolations(root: string): Promise<string[]> {
  const appsRoot = join(root, 'apps');
  const entries = await readdir(appsRoot, { withFileTypes: true });
  const violations: string[] = [];

  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const manifestPath = join(appsRoot, entry.name, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;

    for (const script of ['check', 'artifact:smoke']) {
      if (!manifest.scripts?.[script]) {
        violations.push(`${manifest.name ?? entry.name} must define ${script}`);
      }
    }
  }

  return violations.sort();
}

async function createFixture(manifest: PackageManifest): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mastra-artifact-contract-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/example-agent'), { recursive: true });
  await writeFile(
    join(root, 'apps/example-agent/package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return root;
}

describe('deployable artifact contract', () => {
  it('requires every application to expose check and artifact:smoke', async () => {
    const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));

    await expect(artifactContractViolations(workspaceRoot)).resolves.toEqual([]);
  });

  it('rejects a newly discovered application without both scripts', async () => {
    const root = await createFixture({
      name: '@mastra-agents/example-agent',
      scripts: { check: 'vitest run' },
    });

    await expect(artifactContractViolations(root)).resolves.toEqual([
      '@mastra-agents/example-agent must define artifact:smoke',
    ]);
  });
});
