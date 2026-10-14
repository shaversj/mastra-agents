import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { publishProposalBranch, type PublicationPolicyDecision } from '../src/git/repository.js';

const exec = promisify(execFile);

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'triage-publish-test-'));
  onTestFinished(() => rm(root, { force: true, recursive: true }));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await exec('git', ['init', '--bare', remote]);
  await exec('git', ['init', '-b', 'develop', source]);
  await writeFile(join(source, 'keep.txt'), 'keep\n');
  await writeFile(join(source, 'change.txt'), 'before\n');
  await exec('git', ['-C', source, 'add', 'keep.txt', 'change.txt']);
  await exec('git', [
    '-C',
    source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-m',
    'base',
  ]);
  await exec('git', ['-C', source, 'remote', 'add', 'origin', remote]);
  await exec('git', ['-C', source, 'push', '-u', 'origin', 'develop']);
  const { stdout } = await exec('git', ['-C', source, 'rev-parse', 'HEAD']);
  return { baseSha: stdout.trim(), remote, root, source };
}

const defaultPolicy: PublicationPolicyDecision = {
  authorized: true,
  kind: 'github-token',
  triggersDownstreamWorkflows: false,
};

describe('trusted proposal publisher', () => {
  it('publishes only admitted exact paths from the resolved non-main base', async () => {
    const fixture = await repositoryFixture();
    const lease = { assertCurrent: vi.fn(async () => undefined) };
    const result = await publishProposalBranch({
      baseSha: fixture.baseSha,
      branch: 'triagebot/fix-42',
      changes: {
        changes: [{ kind: 'modified', path: 'change.txt' }],
        files: { 'change.txt': Buffer.from('after\n') },
      },
      defaultBranch: 'develop',
      issueNumber: 42,
      lease,
      policy: defaultPolicy,
      remoteUrl: fixture.remote,
      repository: 'owner/repo',
      sourceRepositoryRoot: fixture.source,
    });

    expect(result).toMatchObject({
      baseSha: fixture.baseSha,
      branch: 'triagebot/fix-42',
    });
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(lease.assertCurrent).toHaveBeenCalledOnce();
    const check = join(fixture.root, 'check');
    await exec('git', ['clone', '--branch', 'triagebot/fix-42', fixture.remote, check]);
    expect(await readFile(join(check, 'change.txt'), 'utf8')).toBe('after\n');
    expect(await readFile(join(check, 'keep.txt'), 'utf8')).toBe('keep\n');
    const { stdout: parent } = await exec('git', ['-C', check, 'rev-parse', 'HEAD^']);
    expect(parent.trim()).toBe(fixture.baseSha);
  });

  it('publishes an admitted empty file', async () => {
    const fixture = await repositoryFixture();
    await expect(
      publishProposalBranch({
        baseSha: fixture.baseSha,
        branch: 'triagebot/fix-42',
        changes: {
          changes: [{ kind: 'added', path: 'empty.txt' }],
          files: { 'empty.txt': Buffer.alloc(0) },
        },
        defaultBranch: 'develop',
        issueNumber: 42,
        lease: { assertCurrent: async () => undefined },
        policy: defaultPolicy,
        remoteUrl: fixture.remote,
        repository: 'owner/repo',
        sourceRepositoryRoot: fixture.source,
      }),
    ).resolves.toMatchObject({ branch: 'triagebot/fix-42' });
  });

  it('never claims or force-pushes an unowned colliding branch', async () => {
    const fixture = await repositoryFixture();
    await exec('git', ['-C', fixture.source, 'checkout', '-b', 'triagebot/fix-42']);
    await writeFile(join(fixture.source, 'foreign.txt'), 'foreign\n');
    await exec('git', ['-C', fixture.source, 'add', 'foreign.txt']);
    await exec('git', [
      '-C',
      fixture.source,
      '-c',
      'user.name=Other',
      '-c',
      'user.email=other@example.com',
      'commit',
      '-m',
      'foreign branch',
    ]);
    await exec('git', ['-C', fixture.source, 'push', 'origin', 'triagebot/fix-42']);
    const { stdout: before } = await exec('git', [
      '--git-dir',
      fixture.remote,
      'rev-parse',
      'refs/heads/triagebot/fix-42',
    ]);

    await expect(
      publishProposalBranch({
        baseSha: fixture.baseSha,
        branch: 'triagebot/fix-42',
        changes: {
          changes: [{ kind: 'modified', path: 'change.txt' }],
          files: { 'change.txt': Buffer.from('after\n') },
        },
        defaultBranch: 'develop',
        issueNumber: 42,
        lease: { assertCurrent: async () => undefined },
        policy: defaultPolicy,
        remoteUrl: fixture.remote,
        repository: 'owner/repo',
        sourceRepositoryRoot: fixture.source,
      }),
    ).rejects.toThrow('BRANCH_OWNERSHIP_CONFLICT');
    const { stdout: after } = await exec('git', [
      '--git-dir',
      fixture.remote,
      'rev-parse',
      'refs/heads/triagebot/fix-42',
    ]);
    expect(after).toBe(before);
  });

  it('rejects untrusted publication policy and unsafe direct-default publication before push', async () => {
    const fixture = await repositoryFixture();
    for (const [policy, branch] of [
      [
        { authorized: false, kind: 'workflow-triggering', triggersDownstreamWorkflows: true },
        'triagebot/fix-42',
      ],
      [defaultPolicy, 'develop'],
    ] as const) {
      await expect(
        publishProposalBranch({
          baseSha: fixture.baseSha,
          branch,
          changes: { changes: [], files: {} },
          defaultBranch: 'develop',
          issueNumber: 42,
          lease: { assertCurrent: async () => undefined },
          policy,
          remoteUrl: fixture.remote,
          repository: 'owner/repo',
          sourceRepositoryRoot: fixture.source,
        }),
      ).rejects.toThrow();
    }
  });

  it('does not persist credentials, helpers, hooks, or authorization headers', async () => {
    const fixture = await repositoryFixture();
    const marker = join(fixture.root, 'executed');
    const helper = join(fixture.root, 'helper.sh');
    await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\n`);
    await exec('chmod', ['+x', helper]);
    await exec('git', ['-C', fixture.source, 'config', 'credential.helper', helper]);
    await exec('git', [
      '-C',
      fixture.source,
      'config',
      'http.extraheader',
      'AUTHORIZATION: secret',
    ]);
    await exec('git', ['-C', fixture.source, 'config', 'core.hooksPath', helper]);

    await publishProposalBranch({
      baseSha: fixture.baseSha,
      branch: 'triagebot/fix-42',
      changes: {
        changes: [{ kind: 'modified', path: 'change.txt' }],
        files: { 'change.txt': Buffer.from('after\n') },
      },
      credential: { token: 'short-lived-token', username: 'x-access-token' },
      defaultBranch: 'develop',
      issueNumber: 42,
      lease: { assertCurrent: async () => undefined },
      policy: defaultPolicy,
      remoteUrl: fixture.remote,
      repository: 'owner/repo',
      sourceRepositoryRoot: fixture.source,
    });

    await expect(readFile(marker)).rejects.toThrow();
    const { stdout } = await exec('git', [
      '--git-dir',
      fixture.remote,
      'config',
      '--local',
      '--list',
    ]);
    expect(stdout).not.toMatch(/short-lived-token|credential\.helper|extraheader|hooksPath/iu);
  });
});
