import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import type { AdmittedChanges } from '../security/diff-policy.js';
import { proposalIdentity, type ProposalIdentity } from '../domain/proposal.js';
import { secureGitEnvironment } from '../security/git-environment.js';
import type { LeaseGuard } from '../github/lease.js';

const executeFile = promisify(execFile);

export type PublicationPolicyDecision =
  | {
      authorized: true;
      kind: 'github-token';
      triggersDownstreamWorkflows: false;
    }
  | {
      authorized: true;
      kind: 'workflow-triggering';
      triggersDownstreamWorkflows: true;
    }
  | {
      authorized: false;
      kind: 'github-token' | 'workflow-triggering';
      triggersDownstreamWorkflows: boolean;
    };

export interface BranchProvenance {
  actionAuthored: true;
  branch: string;
  headSha: string;
  issueNumber: number;
  repository: string;
}

const commonGitConfiguration = [
  '-c',
  'credential.helper=',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'http.extraheader=',
];

function assertPolicy(policy: PublicationPolicyDecision): void {
  if (!policy.authorized) throw new Error('PUBLICATION_POLICY_DENIED');
  if (policy.kind === 'github-token' && policy.triggersDownstreamWorkflows) {
    throw new Error('PUBLICATION_POLICY_INVALID');
  }
  if (policy.kind === 'workflow-triggering' && !policy.triggersDownstreamWorkflows) {
    throw new Error('PUBLICATION_POLICY_INVALID');
  }
}

function assertRemote(remoteUrl: string): void {
  if (!remoteUrl || remoteUrl.includes('\0') || /[\r\n]/u.test(remoteUrl)) {
    throw new Error('PUBLISH_REMOTE_INVALID');
  }
  if (/^https?:/u.test(remoteUrl)) {
    const parsed = new URL(remoteUrl);
    if (parsed.username || parsed.password) throw new Error('PUBLISH_REMOTE_CREDENTIAL_PERSISTED');
  }
}

function assertChangePath(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\0') ||
    path.split(/[\\/]/u).some((part) => !part || part === '.' || part === '..' || part === '.git')
  ) {
    throw new Error('PUBLISH_PATH_INVALID');
  }
}

async function git(
  args: string[],
  options: { environment?: NodeJS.ProcessEnv; failureCode: string },
): Promise<string> {
  try {
    const result = await executeFile('git', [...commonGitConfiguration, ...args], {
      encoding: 'utf8',
      env: options.environment ?? secureGitEnvironment(),
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    });
    return result.stdout;
  } catch {
    throw new Error(options.failureCode);
  }
}

async function writeAskpass(root: string): Promise<string> {
  const path = join(root, 'git-askpass.sh');
  await writeFile(
    path,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  *Username*) printf "%s\\n" "$TRIAGE_GIT_USERNAME" ;;',
      '  *) printf "%s\\n" "$TRIAGE_GIT_TOKEN" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}

function networkEnvironment(input: {
  askpassPath?: string;
  credential?: { token: string; username: string };
}): NodeJS.ProcessEnv {
  const environment = secureGitEnvironment();
  if (!input.credential) return environment;
  if (!input.askpassPath) throw new Error('PUBLISH_CREDENTIAL_HELPER_MISSING');
  if (
    !input.credential.token ||
    input.credential.token.length > 4_096 ||
    !input.credential.username ||
    input.credential.username.length > 200
  ) {
    throw new Error('PUBLISH_CREDENTIAL_INVALID');
  }
  return {
    ...environment,
    GIT_ASKPASS: input.askpassPath,
    GIT_ASKPASS_REQUIRE: 'force',
    TRIAGE_GIT_TOKEN: input.credential.token,
    TRIAGE_GIT_USERNAME: input.credential.username,
  };
}

async function remoteHead(input: {
  askpassPath?: string;
  branch: string;
  credential?: { token: string; username: string };
  remoteUrl: string;
}): Promise<string | null> {
  const output = await git(
    ['ls-remote', '--heads', input.remoteUrl, `refs/heads/${input.branch}`],
    {
      environment: networkEnvironment(input),
      failureCode: 'PUBLISH_REMOTE_READ_FAILED',
    },
  );
  const sha = output.trim().split(/\s/u)[0];
  if (!sha) return null;
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error('PUBLISH_REMOTE_SHA_INVALID');
  return sha;
}

function matchesProvenance(
  provenance: BranchProvenance | undefined,
  expected: { branch: string; headSha: string; issueNumber: number; repository: string },
): boolean {
  return Boolean(
    provenance?.actionAuthored &&
    provenance.branch === expected.branch &&
    provenance.headSha === expected.headSha &&
    provenance.issueNumber === expected.issueNumber &&
    provenance.repository === expected.repository,
  );
}

export async function publishProposalBranch(input: {
  baseSha: string;
  branch: string;
  changes: AdmittedChanges;
  credential?: { token: string; username: string };
  defaultBranch: string;
  eventFingerprint?: string;
  existingBranchProvenance?: BranchProvenance;
  fencingToken?: string;
  issueNumber: number;
  lease: LeaseGuard;
  policy: PublicationPolicyDecision;
  remoteUrl: string;
  repository: string;
  sourceRepositoryRoot: string;
}): Promise<ProposalIdentity> {
  assertPolicy(input.policy);
  assertRemote(input.remoteUrl);
  if (input.branch === input.defaultBranch) throw new Error('PUBLISH_DEFAULT_BRANCH_DENIED');
  if (!/^[0-9a-f]{40}$/u.test(input.baseSha)) throw new Error('PUBLISH_BASE_SHA_INVALID');
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error('PUBLISH_ISSUE_INVALID');
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(input.repository)) {
    throw new Error('PUBLISH_REPOSITORY_INVALID');
  }
  for (const value of [input.eventFingerprint, input.fencingToken]) {
    if (value !== undefined && (!value || value.length > 500 || /[\r\n\0]/u.test(value))) {
      throw new Error('PUBLISH_PROVENANCE_INVALID');
    }
  }
  if (input.changes.changes.length === 0) throw new Error('PUBLISH_NO_CHANGES');
  const paths = input.changes.changes.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) throw new Error('PUBLISH_DUPLICATE_PATH');
  for (const path of paths) assertChangePath(path);
  if (Object.keys(input.changes.files).some((path) => !paths.includes(path))) {
    throw new Error('PUBLISH_UNADMITTED_FILE');
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'triage-publisher-'));
  const publisherRoot = join(temporaryRoot, 'repository');
  let askpassPath: string | undefined;
  try {
    askpassPath = input.credential ? await writeAskpass(temporaryRoot) : undefined;
    await git(['clone', '--no-local', '--no-checkout', input.sourceRepositoryRoot, publisherRoot], {
      failureCode: 'PUBLISH_CLONE_FAILED',
    });
    await git(['-C', publisherRoot, 'remote', 'set-url', 'origin', input.remoteUrl], {
      failureCode: 'PUBLISH_REMOTE_SETUP_FAILED',
    });
    const resolvedBase = (
      await git(['-C', publisherRoot, 'rev-parse', `${input.baseSha}^{commit}`], {
        failureCode: 'PUBLISH_BASE_NOT_FOUND',
      })
    ).trim();
    if (resolvedBase !== input.baseSha) throw new Error('PUBLISH_BASE_MISMATCH');
    await git(['-C', publisherRoot, 'checkout', '--detach', input.baseSha], {
      failureCode: 'PUBLISH_CHECKOUT_FAILED',
    });

    const existingHead = await remoteHead({
      ...(askpassPath ? { askpassPath } : {}),
      branch: input.branch,
      ...(input.credential ? { credential: input.credential } : {}),
      remoteUrl: input.remoteUrl,
    });
    if (
      existingHead &&
      !matchesProvenance(input.existingBranchProvenance, {
        branch: input.branch,
        headSha: existingHead,
        issueNumber: input.issueNumber,
        repository: input.repository,
      })
    ) {
      throw new Error('BRANCH_OWNERSHIP_CONFLICT');
    }

    for (const change of input.changes.changes) {
      const absolutePath = join(publisherRoot, change.path);
      if (change.kind === 'deleted') {
        await rm(absolutePath, { force: true });
        continue;
      }
      const content = input.changes.files[change.path];
      if (content === undefined) throw new Error('PUBLISH_FILE_CONTENT_MISSING');
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, { flag: change.kind === 'added' ? 'wx' : 'w' });
    }
    await git(['-C', publisherRoot, 'add', '-A', '--', ...paths], {
      failureCode: 'PUBLISH_STAGE_FAILED',
    });
    const staged = (
      await git(['-C', publisherRoot, 'diff', '--cached', '--name-only', '-z'], {
        failureCode: 'PUBLISH_STAGE_INSPECTION_FAILED',
      })
    )
      .split('\0')
      .filter(Boolean)
      .sort();
    if (JSON.stringify(staged) !== JSON.stringify([...paths].sort())) {
      throw new Error('PUBLISH_STAGED_PATH_MISMATCH');
    }
    const message = [
      `Fix issue #${input.issueNumber}`,
      '',
      `Triage-Agent-Repository: ${input.repository}`,
      `Triage-Agent-Issue: ${input.issueNumber}`,
      `Triage-Agent-Branch: ${input.branch}`,
      `Triage-Agent-Base: ${input.baseSha}`,
      ...(input.eventFingerprint ? [`Triage-Agent-Event: ${input.eventFingerprint}`] : []),
      ...(input.fencingToken ? [`Triage-Agent-Fence: ${input.fencingToken}`] : []),
    ].join('\n');
    await git(
      [
        '-C',
        publisherRoot,
        '-c',
        'user.name=triage-agent[bot]',
        '-c',
        'user.email=triage-agent@users.noreply.github.com',
        'commit',
        '-m',
        message,
      ],
      { failureCode: 'PUBLISH_COMMIT_FAILED' },
    );
    const headSha = (
      await git(['-C', publisherRoot, 'rev-parse', 'HEAD'], {
        failureCode: 'PUBLISH_HEAD_FAILED',
      })
    ).trim();
    const proposal = proposalIdentity({ baseSha: input.baseSha, branch: input.branch, headSha });

    await input.lease.assertCurrent();
    const expected = existingHead ?? '';
    await git(
      [
        '-C',
        publisherRoot,
        'push',
        `--force-with-lease=refs/heads/${input.branch}:${expected}`,
        'origin',
        `HEAD:refs/heads/${input.branch}`,
      ],
      {
        environment: networkEnvironment({
          ...(askpassPath ? { askpassPath } : {}),
          ...(input.credential ? { credential: input.credential } : {}),
        }),
        failureCode: 'PUBLISH_PUSH_FAILED',
      },
    );
    const publishedHead = await remoteHead({
      ...(askpassPath ? { askpassPath } : {}),
      branch: input.branch,
      ...(input.credential ? { credential: input.credential } : {}),
      remoteUrl: input.remoteUrl,
    });
    if (publishedHead !== proposal.headSha) throw new Error('PUBLISH_REMOTE_MISMATCH');
    return proposal;
  } finally {
    if (askpassPath) await unlink(askpassPath).catch(() => undefined);
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
