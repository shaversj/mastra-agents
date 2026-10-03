import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadWorkspaceSnapshot,
  selectAffectedApps,
  type WorkspaceSnapshot,
} from '../../scripts/affected-apps.mjs';

interface FixturePackage {
  dependencies?: Record<string, string>;
  directory: string;
  name: string;
}

interface FixtureOptions {
  lockfileOverrides?: Record<string, unknown>;
  packages?: FixturePackage[];
}

const fixtureRoots: string[] = [];

async function createFixture(options: FixtureOptions = {}): Promise<WorkspaceSnapshot> {
  const root = await mkdtemp(join(tmpdir(), 'affected-apps-'));
  fixtureRoots.push(root);

  const packages = options.packages ?? [
    { directory: 'apps/researcher-agent', name: '@mastra-agents/researcher-agent' },
    { directory: 'apps/writer-agent', name: '@mastra-agents/writer-agent' },
  ];

  const importers: Record<string, unknown> = { '.': { devDependencies: {} } };
  for (const fixturePackage of packages) {
    const packageDirectory = join(root, fixturePackage.directory);
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, 'package.json'),
      `${JSON.stringify(
        {
          name: fixturePackage.name,
          private: true,
          ...(fixturePackage.dependencies ? { dependencies: fixturePackage.dependencies } : {}),
        },
        null,
        2,
      )}\n`,
    );
    importers[fixturePackage.directory] = {
      dependencies: Object.fromEntries(
        Object.entries(fixturePackage.dependencies ?? {}).map(([name, specifier]) => [
          name,
          { specifier, version: `link:${name}` },
        ]),
      ),
    };
  }

  Object.assign(importers, options.lockfileOverrides);
  await writeFile(
    join(root, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\nimporters:\n${Object.entries(importers)
      .map(([importer, value]) => `  ${JSON.stringify(importer)}: ${JSON.stringify(value)}`)
      .join('\n')}\n`,
  );

  return loadWorkspaceSnapshot(root);
}

function selectedApps(
  after: WorkspaceSnapshot,
  changes: string[],
  before?: WorkspaceSnapshot,
): string[] {
  return selectAffectedApps(
    before ? { after, before, changes } : { after, changes },
  ).matrix.include.map(({ app }) => app);
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('affected application selection', () => {
  it('selects only the owner of an app source change', async () => {
    const snapshot = await createFixture();

    expect(selectedApps(snapshot, ['apps/researcher-agent/src/mastra/index.ts'], snapshot)).toEqual(
      ['researcher-agent'],
    );
    expect(selectedApps(snapshot, ['apps/researcher-agent/src/prompt.md'], snapshot)).toEqual([
      'researcher-agent',
    ]);
  });

  it('keeps an app manifest and importer-specific lockfile change narrow', async () => {
    const before = await createFixture({
      lockfileOverrides: {
        'apps/researcher-agent': {
          dependencies: { '@mastra/core': { specifier: '1.0.0', version: '1.0.0' } },
        },
      },
    });
    const after = await createFixture({
      lockfileOverrides: {
        'apps/researcher-agent': {
          dependencies: { '@mastra/core': { specifier: '2.0.0', version: '2.0.0' } },
        },
      },
    });

    const result = selectAffectedApps({
      after,
      before,
      changes: ['apps/researcher-agent/package.json', 'pnpm-lock.yaml'],
    });

    expect(result.matrix.include.map(({ app }) => app)).toEqual(['researcher-agent']);
    expect(result.reasons['researcher-agent']).toContain(
      'lockfile importer changed: apps/researcher-agent',
    );
  });

  it('selects both transitive app dependents of a shared package', async () => {
    const packages: FixturePackage[] = [
      {
        dependencies: { '@mastra-agents/shared-kit': 'workspace:*' },
        directory: 'apps/researcher-agent',
        name: '@mastra-agents/researcher-agent',
      },
      {
        dependencies: { '@mastra-agents/shared-kit': 'workspace:*' },
        directory: 'apps/writer-agent',
        name: '@mastra-agents/writer-agent',
      },
      { directory: 'packages/shared-kit', name: '@mastra-agents/shared-kit' },
    ];
    const snapshot = await createFixture({ packages });

    const result = selectAffectedApps({
      after: snapshot,
      before: snapshot,
      changes: ['packages/shared-kit/src/index.ts'],
    });

    expect(result.matrix.include.map(({ app }) => app)).toEqual([
      'researcher-agent',
      'writer-agent',
    ]);
    expect(result.reasons['researcher-agent']?.[0]).toContain('@mastra-agents/shared-kit');
  });

  it('selects transitive dependents for a shared lockfile importer change', async () => {
    const packages: FixturePackage[] = [
      {
        dependencies: { '@mastra-agents/shared-kit': 'workspace:*' },
        directory: 'apps/researcher-agent',
        name: '@mastra-agents/researcher-agent',
      },
      {
        dependencies: { '@mastra-agents/shared-kit': 'workspace:*' },
        directory: 'apps/writer-agent',
        name: '@mastra-agents/writer-agent',
      },
      { directory: 'packages/shared-kit', name: '@mastra-agents/shared-kit' },
    ];
    const before = await createFixture({
      lockfileOverrides: {
        'packages/shared-kit': {
          dependencies: { nanoid: { specifier: '5.0.0', version: '5.0.0' } },
        },
      },
      packages,
    });
    const after = await createFixture({
      lockfileOverrides: {
        'packages/shared-kit': {
          dependencies: { nanoid: { specifier: '5.1.0', version: '5.1.0' } },
        },
      },
      packages,
    });

    const result = selectAffectedApps({
      after,
      before,
      changes: ['pnpm-lock.yaml'],
    });

    expect(result.matrix.include.map(({ app }) => app)).toEqual([
      'researcher-agent',
      'writer-agent',
    ]);
    expect(result.reasons['writer-agent']).toContain(
      'shared lockfile importer changed: @mastra-agents/shared-kit',
    );
  });

  it('selects every app for a global build input', async () => {
    const snapshot = await createFixture();

    expect(selectedApps(snapshot, ['tsconfig.base.json'], snapshot)).toEqual([
      'researcher-agent',
      'writer-agent',
    ]);
  });

  it('returns an empty matrix for documentation-only changes', async () => {
    const snapshot = await createFixture();
    const result = selectAffectedApps({
      after: snapshot,
      before: snapshot,
      changes: ['README.md', 'docs/architecture.md'],
    });

    expect(result).toMatchObject({ count: 0, matrix: { include: [] } });
    expect(result.summary).toContain('Documentation-only change');
  });

  it('selects every current app when the comparison base is missing', async () => {
    const snapshot = await createFixture();
    const result = selectAffectedApps({
      after: snapshot,
      changes: [],
      fallbackReason: 'comparison base is unavailable',
    });

    expect(result.matrix.include.map(({ app }) => app)).toEqual([
      'researcher-agent',
      'writer-agent',
    ]);
    expect(result.summary).toContain('comparison base is unavailable');
  });

  it('selects a newly added app', async () => {
    const before = await createFixture({
      packages: [{ directory: 'apps/researcher-agent', name: '@mastra-agents/researcher-agent' }],
    });
    const after = await createFixture();

    expect(selectedApps(after, ['apps/writer-agent/package.json'], before)).toEqual([
      'writer-agent',
    ]);
  });

  it('omits a deleted app from build jobs', async () => {
    const before = await createFixture();
    const after = await createFixture({
      packages: [{ directory: 'apps/researcher-agent', name: '@mastra-agents/researcher-agent' }],
    });

    const result = selectAffectedApps({
      after,
      before,
      changes: ['apps/writer-agent/package.json'],
    });

    expect(result.matrix.include).toEqual([]);
    expect(result.summary).toContain('deleted app omitted: apps/writer-agent');
  });

  it('treats a rename as a deletion plus an addition', async () => {
    const before = await createFixture({
      packages: [{ directory: 'apps/researcher-agent', name: '@mastra-agents/researcher-agent' }],
    });
    const after = await createFixture({
      packages: [{ directory: 'apps/writer-agent', name: '@mastra-agents/writer-agent' }],
    });

    expect(
      selectedApps(
        after,
        ['apps/researcher-agent/package.json', 'apps/writer-agent/package.json'],
        before,
      ),
    ).toEqual(['writer-agent']);
  });

  it('selects every app for an unknown input', async () => {
    const snapshot = await createFixture();
    const result = selectAffectedApps({
      after: snapshot,
      before: snapshot,
      changes: ['infrastructure/unclassified.conf'],
    });

    expect(result.matrix.include.map(({ app }) => app)).toEqual([
      'researcher-agent',
      'writer-agent',
    ]);
    expect(result.summary).toContain('unknown path');
  });

  it('selects every app when lockfile importer impact is uncertain', async () => {
    const snapshot = await createFixture();
    const uncertain: WorkspaceSnapshot = {
      ...snapshot,
      importers: null,
      lockfileError: 'pnpm-lock.yaml could not be parsed',
    };

    const result = selectAffectedApps({
      after: uncertain,
      before: snapshot,
      changes: ['pnpm-lock.yaml'],
    });

    expect(result.matrix.include.map(({ app }) => app)).toEqual([
      'researcher-agent',
      'writer-agent',
    ]);
    expect(result.summary).toContain('could not be parsed');
  });
});
