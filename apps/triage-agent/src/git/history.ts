import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { assertCredentialFreeContent } from '../security/diff-policy.js';
import { secureGitEnvironment } from '../security/git-environment.js';

const executeFile = promisify(execFile);
const revisionPattern = /^(?:[0-9a-f]{7,40}|[A-Za-z0-9][A-Za-z0-9._/-]{0,127})$/u;

export interface HistoryLogEntry {
  author: string;
  authoredAt: string;
  message: string;
  sha: string;
}

export interface HistoryBlameEntry {
  author: string;
  authoredAt: string;
  content: string;
  line: number;
  sha: string;
}

export interface HistoryQuery {
  path: string;
  revision: string;
}

export interface HistoryAdapter {
  blame(query: HistoryQuery & { endLine: number; startLine: number }): Promise<HistoryBlameEntry[]>;
  log(query: HistoryQuery): Promise<HistoryLogEntry[]>;
}

const logOutputSchema = z.array(
  z.object({
    author: z.string(),
    authoredAt: z.string(),
    message: z.string(),
    sha: z.string(),
  }),
);
const blameOutputSchema = z.array(
  z.object({
    author: z.string(),
    authoredAt: z.string(),
    content: z.string(),
    line: z.number().int().positive(),
    sha: z.string(),
  }),
);

function assertQuery(query: HistoryQuery): void {
  const pathParts = query.path.split(/[\\/]/u);
  if (
    !revisionPattern.test(query.revision) ||
    query.revision.includes('..') ||
    query.revision.includes('@{') ||
    !query.path ||
    isAbsolute(query.path) ||
    query.path.includes('\0') ||
    pathParts.some((part) => !part || part === '..' || part === '.git')
  ) {
    throw new Error('HISTORY_QUERY_INVALID');
  }
}

async function git(
  repositoryRoot: string,
  args: string[],
  maxOutputBytes: number,
): Promise<string> {
  let result: { stdout: string };
  try {
    result = await executeFile(
      'git',
      [
        '--no-pager',
        '-c',
        'credential.helper=',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'http.extraheader=',
        '-C',
        repositoryRoot,
        ...args,
      ],
      {
        encoding: 'utf8',
        env: secureGitEnvironment(),
        maxBuffer: maxOutputBytes,
        timeout: 10_000,
      },
    );
  } catch {
    throw new Error('HISTORY_QUERY_FAILED');
  }
  assertCredentialFreeContent(result.stdout, 'HISTORY_CREDENTIAL_CONTENT');
  return result.stdout;
}

function parseBlame(output: string, maximum: number): HistoryBlameEntry[] {
  const result: HistoryBlameEntry[] = [];
  let current: { author?: string; authoredAt?: string; line: number; sha: string } | undefined;
  for (const line of output.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/u.exec(line);
    if (header?.[1] && header[2]) {
      current = { line: Number(header[2]), sha: header[1] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('author ')) current.author = line.slice('author '.length);
    if (line.startsWith('author-time ')) {
      current.authoredAt = new Date(Number(line.slice('author-time '.length)) * 1000).toISOString();
    }
    if (line.startsWith('\t')) {
      result.push({
        author: current.author ?? 'unknown',
        authoredAt: current.authoredAt ?? new Date(0).toISOString(),
        content: line.slice(1),
        line: current.line,
        sha: current.sha,
      });
      current = undefined;
      if (result.length >= maximum) break;
    }
  }
  return result;
}

export function createHistoryAdapter(options: {
  maxEntries?: number;
  maxOutputBytes?: number;
  repositoryRoot: string;
}): HistoryAdapter {
  const maxEntries = options.maxEntries ?? 20;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  if (maxEntries < 1 || maxEntries > 100 || maxOutputBytes < 1024 || maxOutputBytes > 1024 * 1024) {
    throw new Error('HISTORY_LIMIT_INVALID');
  }

  return {
    async blame(query) {
      assertQuery(query);
      if (
        !Number.isInteger(query.startLine) ||
        !Number.isInteger(query.endLine) ||
        query.startLine < 1 ||
        query.endLine < query.startLine ||
        query.endLine - query.startLine + 1 > maxEntries
      ) {
        throw new Error('HISTORY_QUERY_INVALID');
      }
      const output = await git(
        options.repositoryRoot,
        [
          'blame',
          '--line-porcelain',
          '-L',
          `${query.startLine},${query.endLine}`,
          query.revision,
          '--',
          query.path,
        ],
        maxOutputBytes,
      );
      return parseBlame(output, maxEntries);
    },
    async log(query) {
      assertQuery(query);
      const output = await git(
        options.repositoryRoot,
        [
          'log',
          '--no-color',
          `--max-count=${maxEntries}`,
          '--format=%H%x1f%an%x1f%aI%x1f%s%x1e',
          query.revision,
          '--',
          query.path,
        ],
        maxOutputBytes,
      );
      return output
        .split('\x1e')
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
          const [sha, author, authoredAt, message] = record.split('\x1f');
          if (!sha || !author || !authoredAt || message === undefined) {
            throw new Error('HISTORY_OUTPUT_INVALID');
          }
          return { author, authoredAt, message, sha };
        });
    },
  };
}

export function createHistoryTools(history: HistoryAdapter) {
  return {
    history_blame: createTool({
      description: 'Read bounded line attribution from trusted repository history.',
      execute: (input) => history.blame(input),
      id: 'history_blame',
      inputSchema: z.object({
        endLine: z.number().int().positive().max(100_000),
        path: z.string().min(1).max(512),
        revision: z.string().min(1).max(128),
        startLine: z.number().int().positive().max(100_000),
      }),
      outputSchema: blameOutputSchema,
    }),
    history_log: createTool({
      description: 'Read bounded commits for one path from trusted repository history.',
      execute: (input) => history.log(input),
      id: 'history_log',
      inputSchema: z.object({
        path: z.string().min(1).max(512),
        revision: z.string().min(1).max(128),
      }),
      outputSchema: logOutputSchema,
    }),
  };
}
