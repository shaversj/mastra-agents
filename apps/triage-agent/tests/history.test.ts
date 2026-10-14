import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { beforeEach, describe, expect, it } from 'vitest';

import { createHistoryAdapter, createHistoryTools } from '../src/git/history.js';

const exec = promisify(execFile);
let repositoryRoot: string;

beforeEach(async () => {
  repositoryRoot = await mkdtemp(join(tmpdir(), 'triage-history-'));
  await exec('git', ['init', '--quiet', repositoryRoot]);
  await exec('git', ['-C', repositoryRoot, 'config', 'user.name', 'Fixture Author']);
  await exec('git', ['-C', repositoryRoot, 'config', 'user.email', 'fixture@example.test']);
  await writeFile(join(repositoryRoot, 'value.txt'), 'intentional behavior\n');
  await exec('git', ['-C', repositoryRoot, 'add', '--', 'value.txt']);
  await exec('git', ['-C', repositoryRoot, 'commit', '--quiet', '-m', 'document intent']);
});

describe('bounded trusted history adapter', () => {
  it('returns capped structured log and blame fields', async () => {
    const history = createHistoryAdapter({ maxEntries: 2, maxOutputBytes: 4096, repositoryRoot });

    await expect(history.log({ path: 'value.txt', revision: 'HEAD' })).resolves.toEqual([
      expect.objectContaining({
        author: 'Fixture Author',
        message: 'document intent',
        sha: expect.stringMatching(/^[0-9a-f]{40}$/u),
      }),
    ]);
    await expect(
      history.blame({ endLine: 1, path: 'value.txt', revision: 'HEAD', startLine: 1 }),
    ).resolves.toEqual([expect.objectContaining({ content: 'intentional behavior', line: 1 })]);
  });

  it.each([
    { path: '../secret', revision: 'HEAD' },
    { path: 'value.txt', revision: '--all' },
    { path: 'value.txt', revision: 'HEAD@{1}' },
  ])('rejects arbitrary Git arguments and escaping paths: %o', async (query) => {
    const history = createHistoryAdapter({ repositoryRoot });
    await expect(history.log(query)).rejects.toThrow('HISTORY_QUERY_INVALID');
  });

  it('does not expose a raw execution or configuration API', () => {
    const history = createHistoryAdapter({ repositoryRoot });
    expect(Object.keys(history).sort()).toEqual(['blame', 'log']);
  });

  it('exposes only typed log and blame tools to the coding agent', async () => {
    const history = createHistoryAdapter({ repositoryRoot });
    const tools = createHistoryTools(history);
    expect(Object.keys(tools).sort()).toEqual(['history_blame', 'history_log']);
    await expect(
      tools.history_log.execute?.({ path: 'value.txt', revision: 'HEAD' }, {} as never),
    ).resolves.toEqual([expect.objectContaining({ message: 'document intent' })]);
  });
});
