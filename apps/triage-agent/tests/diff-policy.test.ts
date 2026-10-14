import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  admitWorkspaceChanges,
  defaultDiffLimits,
  snapshotWorkspace,
} from '../src/security/diff-policy.js';

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'triage-diff-'));
}

describe('change-set admission', () => {
  it('admits bounded regular-file changes with exact content', async () => {
    const root = await workspace();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'value.ts'), 'export const value = 1;\n');
    const baseline = await snapshotWorkspace(root);
    await writeFile(join(root, 'src', 'value.ts'), 'export const value = 2;\n');

    const admitted = await admitWorkspaceChanges({ baseline, workspaceRoot: root });
    expect(admitted.changes).toEqual([
      expect.objectContaining({ kind: 'modified', path: 'src/value.ts' }),
    ]);
    expect(admitted.files['src/value.ts']?.toString('utf8')).toContain('value = 2');
  });

  it.each([
    '.github/workflows/pwn.yml',
    '.github/actions/pwn/action.yml',
    '.git/config',
    'config/.npmrc',
    'config/.env.production',
  ])('rejects protected path %s even when shell-written', async (path) => {
    const root = await workspace();
    const baseline = await snapshotWorkspace(root);
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), 'malicious\n');
    await expect(admitWorkspaceChanges({ baseline, workspaceRoot: root })).rejects.toThrow(
      'DIFF_PROTECTED_PATH',
    );
  });

  it('rejects credential-like content and symlink additions', async () => {
    const secretRoot = await workspace();
    const secretBaseline = await snapshotWorkspace(secretRoot);
    await writeFile(secretRoot + '/leak.txt', 'ghp_abcdefghijklmnopqrstuvwxyz1234567890\n');
    await expect(
      admitWorkspaceChanges({ baseline: secretBaseline, workspaceRoot: secretRoot }),
    ).rejects.toThrow('DIFF_CREDENTIAL_CONTENT');

    const linkRoot = await workspace();
    const linkBaseline = await snapshotWorkspace(linkRoot);
    await symlink('/etc/passwd', join(linkRoot, 'escape'));
    await expect(
      admitWorkspaceChanges({ baseline: linkBaseline, workspaceRoot: linkRoot }),
    ).rejects.toThrow('DIFF_SYMLINK');
  });

  it('enforces file-count, individual-file, and aggregate-diff ceilings', async () => {
    const root = await workspace();
    const baseline = await snapshotWorkspace(root);
    await writeFile(join(root, 'one.txt'), '1'.repeat(8));
    await writeFile(join(root, 'two.txt'), '2'.repeat(8));

    await expect(
      admitWorkspaceChanges({
        baseline,
        limits: { ...defaultDiffLimits, maxChangedFiles: 1 },
        workspaceRoot: root,
      }),
    ).rejects.toThrow('DIFF_TOO_MANY_FILES');
    await expect(
      admitWorkspaceChanges({
        baseline,
        limits: { ...defaultDiffLimits, maxFileBytes: 4 },
        workspaceRoot: root,
      }),
    ).rejects.toThrow('DIFF_FILE_TOO_LARGE');
    await expect(
      admitWorkspaceChanges({
        baseline,
        limits: { ...defaultDiffLimits, maxDiffBytes: 10 },
        workspaceRoot: root,
      }),
    ).rejects.toThrow('DIFF_TOO_LARGE');
  });
});
