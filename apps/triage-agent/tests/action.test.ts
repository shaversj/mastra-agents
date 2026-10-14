import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { parseActionInputs } from '../src/action/inputs.js';
import { runAction } from '../src/action/index.js';
import {
  createLiveActionDependencies,
  deleteRemoteBranchWithLease,
  priorLeaseOwnerDiffers,
  publicationPolicy,
  resolvePreparedDependencyPath,
  resolveProjectSkillFile,
  runRegisteredWorkflow,
} from '../src/action/live-runtime.js';
import {
  runTriageAction,
  type ActionControllerDependencies,
  type ActionExecution,
  type ActionLease,
  type ModelRuntime,
  type RoutingSnapshot,
} from '../src/action/run.js';
import { defaultLifecycleLabels } from '../src/domain/lifecycle.js';
import { decodeMarker, encodeMarker } from '../src/domain/markers.js';
import { proposalIdentity } from '../src/domain/proposal.js';
import { projectGitHubEvent } from '../src/domain/event-projection.js';

const opened = JSON.parse(
  await readFile(new URL('./fixtures/events/issue-opened.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const closed = JSON.parse(
  await readFile(new URL('./fixtures/events/issue-closed.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const commentCreated = JSON.parse(
  await readFile(new URL('./fixtures/events/comment-created.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

function routingSnapshot(overrides: Partial<RoutingSnapshot> = {}): RoutingSnapshot {
  return {
    activationPolicy: 'automatic-public',
    botLogins: ['github-actions[bot]'],
    branchProvenanceVerified: true,
    githubIdentityVerified: true,
    ledger: {
      failureCount: 0,
      generation: 0,
      modelEventCount: 0,
      processedEventFingerprints: [],
    },
    lifecycleLabels: defaultLifecycleLabels,
    maxModelEvents: 4,
    ...overrides,
  };
}

function modelInputs() {
  return parseActionInputs({
    INPUT_ANTHROPIC_API_KEY: 'provider-canary',
    INPUT_READ_TOKEN: 'read-canary',
    INPUT_TRIAGE_SKILL: '.agents/skills/triage',
    INPUT_WRITE_TOKEN: 'write-canary',
  });
}

function dependencies(overrides: Partial<ActionControllerDependencies> = {}) {
  const lease: ActionLease = {
    assertCurrent: vi.fn(async () => undefined),
    fencingToken: 'fence-1',
    release: vi.fn(async () => undefined),
  };
  const runtime: ModelRuntime = {
    close: vi.fn(async () => undefined),
  };
  const execution: ActionExecution = {
    reasonCode: 'FIX_PROPOSED',
    state: 'fix_pending',
  };
  const value: ActionControllerDependencies = {
    acquireLease: vi.fn(async () => lease),
    createModelRuntime: vi.fn(async () => runtime),
    executeRoute: vi.fn(async () => execution),
    inspectModelCapabilities: vi.fn(async () => ({
      checkoutSafe: true,
      labelsPresent: true,
      prSkillPresent: true,
      sandboxAvailable: true,
      triageSkillPresent: true,
    })),
    loadModelInputs: vi.fn(async () => modelInputs()),
    readRoutingState: vi.fn(async () => routingSnapshot()),
    reconcileFailure: vi.fn(async () => undefined),
    reconcile: vi.fn(async ({ event, execution: completed, route }) => ({
      appId: 'triage-agent' as const,
      issueNumber: event.issue.number,
      reasonCode: completed.reasonCode,
      repository: event.repository.fullName,
      route: route.kind,
      state: completed.state,
      status: 'completed' as const,
    })),
    ...overrides,
  };
  return { lease, runtime, value };
}

function request(payload: unknown = opened) {
  return {
    deliveryId: 'delivery-1',
    eventName: 'issues' as const,
    payload,
    workflowRunId: 100,
  };
}

describe('Action controller', () => {
  it('accepts only regular, symlink-free project skill files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'triage-skill-path-'));
    const outside = await mkdtemp(join(tmpdir(), 'triage-skill-outside-'));
    try {
      const validDirectory = join(root, '.agents', 'skills', 'triage');
      await mkdir(validDirectory, { recursive: true });
      await writeFile(join(validDirectory, 'SKILL.md'), '# Triage\n');
      await writeFile(join(outside, 'SKILL.md'), '# Outside\n');
      await symlink(outside, join(root, '.agents', 'skills', 'linked'));

      await expect(resolveProjectSkillFile(root, '.agents/skills/triage')).resolves.toBe(
        await realpath(join(validDirectory, 'SKILL.md')),
      );
      await expect(
        resolveProjectSkillFile(root, '../triage-skill-outside'),
      ).resolves.toBeUndefined();
      await expect(resolveProjectSkillFile(root, outside)).resolves.toBeUndefined();
      await expect(resolveProjectSkillFile(root, '.agents/skills/linked')).resolves.toBeUndefined();
    } finally {
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(outside, { force: true, recursive: true }),
      ]);
    }
  });

  it('accepts only contained, symlink-free prepared dependency paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'triage-prepared-path-'));
    const outside = await mkdtemp(join(tmpdir(), 'triage-prepared-outside-'));
    try {
      const prepared = join(root, '.triage', 'dependencies');
      await mkdir(prepared, { recursive: true });
      await writeFile(join(prepared, 'runtime.js'), 'export {};\n');
      await symlink(outside, join(root, '.triage', 'linked'));

      await expect(resolvePreparedDependencyPath(root, '.triage/dependencies')).resolves.toBe(
        await realpath(prepared),
      );
      await expect(resolvePreparedDependencyPath(root, '.triage/linked')).resolves.toBeUndefined();
      await expect(resolvePreparedDependencyPath(root, '../outside')).resolves.toBeUndefined();
    } finally {
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(outside, { force: true, recursive: true }),
      ]);
    }
  });

  it('constructs the normal live dependency graph without provider-only inputs', async () => {
    const inputs = parseActionInputs({
      INPUT_READ_TOKEN: 'read-canary',
      INPUT_WRITE_TOKEN: 'write-canary',
    });
    const live = createLiveActionDependencies({
      environment: { GITHUB_REPOSITORY: 'example/widgets' },
      inputs,
    });

    await expect(live.loadModelInputs()).resolves.toBe(inputs);
    expect(live).toEqual(
      expect.objectContaining({
        acquireLease: expect.any(Function),
        createModelRuntime: expect.any(Function),
        executeRoute: expect.any(Function),
        reconcile: expect.any(Function),
      }),
    );
  });

  it('queries prior workflow state when either the run ID or rerun attempt changes', () => {
    const owner = { workflowRunAttempt: 1, workflowRunId: 100 };

    expect(priorLeaseOwnerDiffers(owner, 100, 1)).toBe(false);
    expect(priorLeaseOwnerDiffers(owner, 100, 2)).toBe(true);
    expect(priorLeaseOwnerDiffers(owner, 101, 1)).toBe(true);
  });

  it('reads the complete bounded comment history using the server pagination links', async () => {
    const inputs = parseActionInputs({
      INPUT_READ_TOKEN: 'read-canary',
      INPUT_WRITE_TOKEN: 'write-canary',
    });
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (value: string | URL | Request) => {
        const url = String(value);
        requests.push(url);
        if (url.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'github-actions[bot]' }), { status: 200 });
        }
        const page = new URL(url).searchParams.get('page');
        const comments =
          page === '1'
            ? Array.from({ length: 100 }, (_, index) => ({
                body: '',
                id: index + 1,
                user: { login: 'someone' },
              }))
            : [{ body: '', id: 101, user: { login: 'someone' } }];
        return new Response(JSON.stringify(comments), {
          headers: {
            date: 'Wed, 14 Oct 2026 12:00:00 GMT',
            ...(page === '1'
              ? {
                  link: '<https://api.github.com/repos/example/widgets/issues/42/comments?per_page=100&page=2>; rel="last"',
                }
              : {}),
          },
          status: 200,
        });
      }),
    );
    try {
      const live = createLiveActionDependencies({
        environment: { GITHUB_REPOSITORY: 'example/widgets' },
        inputs,
      });
      const event = projectGitHubEvent('issues', opened, 'delivery-pagination');
      await live.readRoutingState(event);

      const commentRequests = requests.filter((url) => url.includes('/comments?'));
      expect(commentRequests).toHaveLength(2);
      expect(commentRequests[0]).toContain('page=1');
      expect(commentRequests[1]).toContain('page=2');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed when comment history exceeds the authoritative five-page budget', async () => {
    const inputs = parseActionInputs({
      INPUT_READ_TOKEN: 'read-canary',
      INPUT_WRITE_TOKEN: 'write-canary',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (value: string | URL | Request) => {
        const url = String(value);
        if (url.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'github-actions[bot]' }), { status: 200 });
        }
        return new Response(JSON.stringify([]), {
          headers: {
            date: 'Wed, 14 Oct 2026 12:00:00 GMT',
            link: '<https://api.github.com/repos/example/widgets/issues/42/comments?per_page=100&page=6>; rel="last"',
          },
          status: 200,
        });
      }),
    );
    try {
      const live = createLiveActionDependencies({
        environment: { GITHUB_REPOSITORY: 'example/widgets' },
        inputs,
      });

      await expect(
        live.readRoutingState(projectGitHubEvent('issues', opened, 'delivery-long-history')),
      ).rejects.toThrowError('COMMENT_HISTORY_INCOMPLETE');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('resolves hardened issue-event trust from the event sender repository permission', async () => {
    const inputs = parseActionInputs({
      INPUT_ACTIVATION_POLICY: 'trusted',
      INPUT_READ_TOKEN: 'read-canary',
      INPUT_WRITE_TOKEN: 'write-canary',
    });
    const payload = {
      ...opened,
      issue: {
        ...(opened.issue as Record<string, unknown>),
        author_association: 'OWNER',
      },
      sender: { id: 9001, login: 'reopener', type: 'User' },
    };
    let permission = 'read';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (value: string | URL | Request) => {
        const url = String(value);
        if (url.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'github-actions[bot]' }), { status: 200 });
        }
        if (url.includes('/collaborators/reopener/permission')) {
          return new Response(JSON.stringify({ permission }), {
            headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
            status: 200,
          });
        }
        return new Response(JSON.stringify([]), {
          headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
          status: 200,
        });
      }),
    );
    try {
      const live = createLiveActionDependencies({
        environment: { GITHUB_REPOSITORY: 'example/widgets' },
        inputs,
      });
      const event = projectGitHubEvent('issues', payload, 'delivery-hardened-sender');

      await expect(live.readRoutingState(event)).resolves.toMatchObject({
        trustedActivation: false,
        trustedReset: false,
      });
      permission = 'write';
      await expect(live.readRoutingState(event)).resolves.toMatchObject({
        trustedActivation: true,
        trustedReset: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps hardened comment-event trust bound to the comment association', async () => {
    const inputs = parseActionInputs({
      INPUT_ACTIVATION_POLICY: 'trusted',
      INPUT_READ_TOKEN: 'same-token',
      INPUT_WRITE_TOKEN: 'same-token',
    });
    const payload = {
      ...commentCreated,
      comment: {
        ...(commentCreated.comment as Record<string, unknown>),
        author_association: 'MEMBER',
      },
    };
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (value: string | URL | Request) => {
        const url = String(value);
        requests.push(url);
        if (url.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'github-actions[bot]' }), { status: 200 });
        }
        return new Response(JSON.stringify([]), {
          headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
          status: 200,
        });
      }),
    );
    try {
      const live = createLiveActionDependencies({
        environment: { GITHUB_REPOSITORY: 'example/widgets' },
        inputs,
      });
      await expect(
        live.readRoutingState(
          projectGitHubEvent('issue_comment', payload, 'delivery-trusted-comment'),
        ),
      ).resolves.toMatchObject({ trustedActivation: true, trustedReset: true });
      expect(requests.some((url) => url.includes('/collaborators/'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('binds the default publication policy to the GitHub Actions bot identity', () => {
    const defaults = parseActionInputs({
      INPUT_READ_TOKEN: 'read-canary',
      INPUT_WRITE_TOKEN: 'write-canary',
    });
    const elevated = parseActionInputs({
      INPUT_ALLOW_DOWNSTREAM_WORKFLOWS: 'true',
      INPUT_PUBLICATION_TOKEN_KIND: 'workflow-triggering',
      INPUT_READ_TOKEN: 'read-canary',
      INPUT_SAFE_DOWNSTREAM_CI: 'true',
      INPUT_WRITE_TOKEN: 'write-canary',
    });

    expect(publicationPolicy(defaults, 'github-actions[bot]')).toEqual({
      authorized: true,
      kind: 'github-token',
      triggersDownstreamWorkflows: false,
    });
    expect(publicationPolicy(defaults, 'maintainer')).toEqual({
      authorized: false,
      kind: 'github-token',
      triggersDownstreamWorkflows: false,
    });
    expect(publicationPolicy(defaults, 'custom-app[bot]')).toEqual({
      authorized: false,
      kind: 'github-token',
      triggersDownstreamWorkflows: false,
    });
    expect(publicationPolicy(elevated, 'custom-app[bot]')).toEqual({
      authorized: true,
      kind: 'workflow-triggering',
      triggersDownstreamWorkflows: true,
    });
  });

  it('denies a self-declared default token before routing when its identity is not GitHub Actions', async () => {
    const inputs = parseActionInputs({
      INPUT_READ_TOKEN: 'human-token',
      INPUT_WRITE_TOKEN: 'human-token',
    });
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (value: string | URL | Request) => {
        requests.push(String(value));
        return new Response(JSON.stringify({ login: 'maintainer' }), { status: 200 });
      }),
    );
    try {
      const live = createLiveActionDependencies({
        environment: { GITHUB_REPOSITORY: 'example/widgets' },
        inputs,
      });

      await expect(
        live.readRoutingState(projectGitHubEvent('issues', opened, 'delivery-human-default-token')),
      ).rejects.toThrowError('PUBLICATION_POLICY_DENIED');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatch(/\/user$/u);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('atomically rejects branch deletion when the remote head moved after discovery', async () => {
    const expectedSha = 'a'.repeat(40);
    let remoteHead = expectedSha;
    remoteHead = 'b'.repeat(40);
    const execute = vi.fn(async (_file: string, args: readonly string[]) => {
      const lease = args.find((value) => value.startsWith('--force-with-lease='));
      if (remoteHead !== expectedSha || !lease?.endsWith(`:${expectedSha}`)) {
        throw new Error('stale info');
      }
      return { stderr: '', stdout: '' };
    });

    await expect(
      deleteRemoteBranchWithLease({
        branch: 'triagebot/fix-42',
        execute,
        expectedSha,
        remoteUrl: 'https://github.com/example/widgets.git',
        token: 'write-canary',
      }),
    ).rejects.toThrowError('PROPOSAL_BRANCH_DELETE_FAILED');
    expect(execute).toHaveBeenCalledOnce();
    const args = execute.mock.calls[0]?.[1] ?? [];
    expect(args).toContain(`--force-with-lease=refs/heads/triagebot/fix-42:${expectedSha}`);
    expect(args).toContain(':refs/heads/triagebot/fix-42');
    expect(args).not.toContain('write-canary');
  });

  it('boundedly discovers every configured repository label before model setup', async () => {
    const inputs = modelInputs();
    const requests: string[] = [];
    const requiredLabels = [
      ...Object.values(inputs.labels),
      inputs.prFixVerifiedLabel,
      ...Array.from({ length: 89 }, (_, index) => `filler-${index}`),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (value: string | URL | Request) => {
        const url = String(value);
        requests.push(url);
        if (url.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'github-actions[bot]' }), { status: 200 });
        }
        if (url.includes('/labels?')) {
          return new Response(
            JSON.stringify(requiredLabels.map((name) => ({ name })).slice(0, 100)),
            { headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' }, status: 200 },
          );
        }
        return new Response(JSON.stringify([]), {
          headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
          status: 200,
        });
      }),
    );
    try {
      const live = createLiveActionDependencies({
        environment: { GITHUB_REPOSITORY: 'example/widgets' },
        inputs,
      });
      const event = projectGitHubEvent('issues', opened, 'delivery-labels');
      await live.readRoutingState(event);

      await expect(
        live.inspectModelCapabilities({
          event,
          inputs,
          route: {
            eventFingerprint: event.eventFingerprint,
            generation: 1,
            kind: 'triage',
            resetBudgets: false,
          },
        }),
      ).resolves.toMatchObject({ labelsPresent: true });
      expect(requests.filter((url) => url.includes('/labels?'))).toHaveLength(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('recovers an exact action-authored proposal push before its proposal marker', async () => {
    const inputs = modelInputs();
    const event = projectGitHubEvent('issues', opened, 'delivery-push-recovery');
    const baseSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const marker = encodeMarker({
      eventFingerprint: event.eventFingerprint,
      fencingToken: 'fence-1',
      generation: 1,
      issueNumber: event.issue.number,
      kind: 'model_event',
      repository: event.repository.fullName,
      state: 'needs_triage',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (value: string | URL | Request) => {
        const url = String(value);
        if (url.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'github-actions[bot]' }), { status: 200 });
        }
        if (url.includes('/comments?')) {
          return new Response(
            JSON.stringify([{ body: marker, id: 1, user: { login: 'github-actions[bot]' } }]),
            { headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' }, status: 200 },
          );
        }
        if (url.includes('/git/ref/heads/')) {
          return new Response(JSON.stringify({ object: { sha: headSha } }), {
            headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
            status: 200,
          });
        }
        if (url.includes(`/git/commits/${headSha}`)) {
          return new Response(
            JSON.stringify({
              message: [
                'Fix issue #42',
                '',
                `Triage-Agent-Repository: ${event.repository.fullName}`,
                `Triage-Agent-Issue: ${event.issue.number}`,
                `Triage-Agent-Branch: triagebot/fix-${event.issue.number}`,
                `Triage-Agent-Base: ${baseSha}`,
                `Triage-Agent-Event: ${event.eventFingerprint}`,
                'Triage-Agent-Fence: fence-1',
              ].join('\n'),
              parents: [{ sha: baseSha }],
            }),
            { headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' }, status: 200 },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    try {
      const live = createLiveActionDependencies({
        environment: {
          GITHUB_REPOSITORY: event.repository.fullName,
          GITHUB_SHA: baseSha,
        },
        inputs,
      });
      await expect(live.readRoutingState(event)).resolves.toMatchObject({
        recovery: {
          kind: 'recover',
          proposal: {
            baseSha,
            branch: `triagebot/fix-${event.issue.number}`,
            headSha,
          },
          recoveryKind: 'proposal',
          state: 'fix_pending',
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('adopts an exact action-owned PR and repairs both issue and PR labels', async () => {
    const inputs = parseActionInputs({
      INPUT_ANTHROPIC_API_KEY: 'provider-canary',
      INPUT_AUTO_PR_ON_FIX: 'true',
      INPUT_READ_TOKEN: 'read-canary',
      INPUT_TRIAGE_SKILL: '.agents/skills/triage',
      INPUT_WRITE_TOKEN: 'write-canary',
    });
    const event = projectGitHubEvent('issues', opened, 'delivery-pr-recovery');
    const proposal = proposalIdentity({
      baseSha: 'a'.repeat(40),
      branch: `triagebot/fix-${event.issue.number}`,
      headSha: 'b'.repeat(40),
    });
    const comments = [
      {
        body: encodeMarker({
          eventFingerprint: event.eventFingerprint,
          fencingToken: 'fence-1',
          generation: 1,
          issueNumber: event.issue.number,
          kind: 'proposal',
          proposal,
          repository: event.repository.fullName,
          state: 'fix_pending',
        }),
        id: 1,
        user: { login: 'github-actions[bot]' },
      },
    ];
    const labels = new Map<number, string[]>([
      [event.issue.number, [defaultLifecycleLabels.needs_triage]],
      [77, []],
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
        const url = String(value);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'github-actions[bot]' }), { status: 200 });
        }
        if (url.includes('/comments') && method === 'GET') {
          return new Response(JSON.stringify(comments), {
            headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
            status: 200,
          });
        }
        if (url.includes('/comments') && method === 'POST') {
          const body = String(JSON.parse(String(init?.body)).body);
          comments.unshift({ body, id: 2, user: { login: 'github-actions[bot]' } });
          return new Response(JSON.stringify(comments[0]), {
            headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
            status: 200,
          });
        }
        if (url.includes('/pulls?')) {
          return new Response(
            JSON.stringify([
              {
                base: { ref: event.repository.defaultBranch },
                body: `Proposal: \`${proposal.id}\`\n\nThis pull request was created by the triage agent.`,
                head: { ref: proposal.branch, sha: proposal.headSha },
                number: 77,
                state: 'open',
                title: 'Fix issue',
                user: { login: 'github-actions[bot]' },
              },
            ]),
            { headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' }, status: 200 },
          );
        }
        if (url.includes('/git/ref/heads/')) {
          return new Response(JSON.stringify({ object: { sha: proposal.headSha } }), {
            headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
            status: 200,
          });
        }
        const issueMatch = /\/issues\/(\d+)(?:\/labels)?$/u.exec(new URL(url).pathname);
        if (issueMatch?.[1]) {
          const issueNumber = Number(issueMatch[1]);
          if (method === 'PUT') {
            labels.set(issueNumber, JSON.parse(String(init?.body)).labels as string[]);
            return new Response(JSON.stringify([]), {
              headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
              status: 200,
            });
          }
          return new Response(
            JSON.stringify({ labels: (labels.get(issueNumber) ?? []).map((name) => ({ name })) }),
            { headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' }, status: 200 },
          );
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    try {
      const live = createLiveActionDependencies({
        environment: { GITHUB_REPOSITORY: event.repository.fullName },
        inputs,
      });
      const snapshot = await live.readRoutingState(event);
      const route = snapshot.recovery;
      expect(route).toMatchObject({
        kind: 'recover',
        pullRequestId: 77,
        recoveryKind: 'transition',
        state: 'fix_verified',
      });
      if (!route) throw new Error('RECOVERY_ROUTE_MISSING');
      const lease = {
        assertCurrent: vi.fn(async () => undefined),
        fencingToken: 'fence-2',
        release: vi.fn(async () => undefined),
      };
      await live.reconcile({
        event,
        execution: { reasonCode: 'PARTIAL_RECONCILIATION_RECOVERED', state: 'fix_verified' },
        lease,
        route,
      });

      expect(labels.get(event.issue.number)).toContain(defaultLifecycleLabels.fix_verified);
      expect(labels.get(77)).toContain(inputs.prFixVerifiedLabel);
      expect(
        comments.some(
          ({ body }) => decodeMarker(body, { authorIsAction: true })?.kind === 'complete',
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('runs full triage in the same generation after actionable retriage classification', async () => {
    const inputs = modelInputs();
    const workflowIds: string[] = [];
    let commentInput: unknown;
    let retriageInput: unknown;
    const runWorkflow = vi.fn(async (_mastra: unknown, workflowId: string, inputData: unknown) => {
      workflowIds.push(workflowId);
      if (workflowId === 'triage-comment-workflow') commentInput = inputData;
      if (workflowId === 'triage-workflow') retriageInput = inputData;
      return workflowId === 'triage-comment-workflow'
        ? {
            action: 'rerun_triage',
            commentId: 5001,
            reasonCode: 'ACTIONABLE_RETRIAGE',
            state: 'needs_triage',
          }
        : {
            attemptId: 'issue_comment:created:2001:5001:delivery-retriage',
            evidence: [],
            generation: 1,
            mutationPlan: {
              kind: 'triage_outcome',
              reasonCode: 'not_a_bug',
              report: {
                details: ['The issue does not match the supported bug criteria.'],
                headline: 'Triage complete',
              },
              state: 'not_actionable',
            },
            state: 'not_actionable',
            stoppedAt: 'reproduce',
          };
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
        const url = String(value);
        if (url.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'github-actions[bot]' }), { status: 200 });
        }
        if (url.includes('/comments') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              body: String(init.body ?? ''),
              id: 9001,
              user: { login: 'github-actions[bot]' },
            }),
            { headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' }, status: 200 },
          );
        }
        return new Response(JSON.stringify([]), {
          headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
          status: 200,
        });
      }),
    );
    try {
      const live = createLiveActionDependencies({
        environment: {
          GITHUB_REPOSITORY: 'example/widgets',
          GITHUB_SHA: 'a'.repeat(40),
        },
        inputs,
        runWorkflow,
      });
      const event = projectGitHubEvent('issue_comment', commentCreated, 'delivery-retriage');
      await live.readRoutingState(event);
      const result = await live.executeRoute({
        event,
        lease: {
          assertCurrent: async () => undefined,
          fencingToken: 'fence-1',
          release: async () => undefined,
        },
        route: {
          commentId: 5001,
          generation: 1,
          kind: 'classify_retriage',
          state: 'unable_to_reproduce',
        },
        runtime: { close: async () => undefined, mastra: {} },
      });

      expect(workflowIds).toEqual(['triage-comment-workflow', 'triage-workflow']);
      expect(commentInput).toMatchObject({
        issue: {
          body: event.issue.body,
          number: event.issue.number,
          reporterLogin: event.issue.reporterLogin,
          title: event.issue.title,
        },
      });
      expect(retriageInput).toMatchObject({
        triggeringComment: {
          body: 'You can reproduce this with npm test -- widget.',
          id: 5001,
        },
      });
      expect(result).toMatchObject({ reasonCode: 'TRIAGE_OUTCOME', state: 'not_actionable' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('idempotently reconciles unexpected model failures with fenced markers and preserved labels', async () => {
    const inputs = parseActionInputs({
      INPUT_READ_TOKEN: 'same-token',
      INPUT_WRITE_TOKEN: 'same-token',
    });
    const event = projectGitHubEvent('issues', opened, 'delivery-model-failure');
    const comments: Array<{ body: string; id: number; user: { login: string } }> = [];
    let labels = [
      'customer-reported',
      defaultLifecycleLabels.needs_triage,
      defaultLifecycleLabels.fix_pending,
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
        const url = String(value);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/user')) {
          return new Response(JSON.stringify({ login: 'github-actions[bot]' }), { status: 200 });
        }
        if (url.includes('/comments') && method === 'GET') {
          return new Response(JSON.stringify(comments), {
            headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
            status: 200,
          });
        }
        if (url.includes('/comments') && method === 'POST') {
          const body = String((JSON.parse(String(init?.body)) as { body: string }).body);
          const comment = {
            body,
            id: comments.length + 1,
            user: { login: 'github-actions[bot]' },
          };
          comments.push(comment);
          return new Response(JSON.stringify(comment), {
            headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
            status: 200,
          });
        }
        if (url.endsWith(`/issues/${event.issue.number}`) && method === 'GET') {
          return new Response(JSON.stringify({ labels: labels.map((name) => ({ name })) }), {
            headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
            status: 200,
          });
        }
        if (url.endsWith(`/issues/${event.issue.number}/labels`) && method === 'PUT') {
          labels = (JSON.parse(String(init?.body)) as { labels: string[] }).labels;
          return new Response(JSON.stringify(labels.map((name) => ({ name }))), {
            headers: { date: 'Wed, 14 Oct 2026 12:00:00 GMT' },
            status: 200,
          });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    try {
      const live = createLiveActionDependencies({
        environment: { GITHUB_REPOSITORY: event.repository.fullName },
        inputs,
      });
      await live.readRoutingState(event);
      const lease = {
        assertCurrent: vi.fn(async () => undefined),
        fencingToken: 'fence-failure',
        release: async () => undefined,
      };
      const failure = {
        event,
        lease,
        reasonCode: 'ACTION_FAILED',
        route: {
          eventFingerprint: event.eventFingerprint,
          generation: 1,
          kind: 'triage' as const,
          resetBudgets: false,
        },
      };

      await live.reconcileFailure(failure);
      await live.reconcileFailure(failure);

      expect(labels).toEqual([defaultLifecycleLabels.failed, 'customer-reported']);
      expect(
        comments.map(({ body }) => decodeMarker(body, { authorIsAction: true })?.kind),
      ).toEqual(['failure', 'complete']);
      expect(lease.assertCurrent).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('clears secret-bearing input variables before the first controller boundary', async () => {
    const environment: Record<string, string | undefined> = {
      GITHUB_DELIVERY: 'delivery-entrypoint',
      GITHUB_EVENT_NAME: 'issues',
      GITHUB_EVENT_PATH: new URL('./fixtures/events/issue-opened.json', import.meta.url).pathname,
      GITHUB_RUN_ID: '100',
      INPUT_ANTHROPIC_API_KEY: 'provider-canary',
      INPUT_PREVIEW_TOKEN: 'preview-canary',
      INPUT_READ_TOKEN: 'read-canary',
      INPUT_WRITE_TOKEN: 'write-canary',
    };
    const setup = dependencies({
      readRoutingState: vi.fn(async (event) => {
        expect(environment.INPUT_ANTHROPIC_API_KEY).toBeUndefined();
        expect(environment.INPUT_PREVIEW_TOKEN).toBeUndefined();
        expect(environment.INPUT_READ_TOKEN).toBeUndefined();
        expect(environment.INPUT_WRITE_TOKEN).toBeUndefined();
        return routingSnapshot({
          ledger: {
            failureCount: 0,
            generation: 0,
            modelEventCount: 0,
            processedEventFingerprints: [event.eventFingerprint],
          },
        });
      }),
    });
    let output = '';

    await runAction(environment, {
      dependencies: setup.value,
      stdout: { write: (chunk) => ((output += String(chunk)), true) },
    });

    expect(output).not.toMatch(/provider-canary|preview-canary|read-canary|write-canary/u);
  });

  it('returns a safe pull-request transport no-op without constructing dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'triage-pull-request-noop-'));
    try {
      const eventPath = join(root, 'event.json');
      const outputPath = join(root, 'output.txt');
      const summaryPath = join(root, 'summary.md');
      await writeFile(
        eventPath,
        JSON.stringify({
          number: 42,
          repository: (opened as { repository: unknown }).repository,
        }),
      );
      const setup = dependencies();

      const result = await runAction(
        {
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
          GITHUB_RUN_ID: '100',
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'example/widgets',
          GITHUB_STEP_SUMMARY: summaryPath,
        },
        {
          dependencies: setup.value,
          stdout: { write: () => true },
        },
      );

      expect(result).toMatchObject({
        issueNumber: 42,
        reasonCode: 'pull_request',
        repository: 'example/widgets',
        route: 'noop',
        status: 'noop',
      });
      await expect(readFile(outputPath, 'utf8')).resolves.toContain('reason-code=pull_request');
      await expect(readFile(summaryPath, 'utf8')).resolves.toContain('- Status: noop');
      expect(setup.value.readRoutingState).not.toHaveBeenCalled();
      expect(setup.value.loadModelInputs).not.toHaveBeenCalled();
      expect(setup.value.acquireLease).not.toHaveBeenCalled();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('keeps fallback delivery identity stable across workflow rerun attempts', async () => {
    const deliveryIds: string[] = [];
    const setup = dependencies({
      readRoutingState: vi.fn(async (event) => {
        deliveryIds.push(event.deliveryId);
        return routingSnapshot({
          ledger: {
            failureCount: 0,
            generation: 0,
            modelEventCount: 0,
            processedEventFingerprints: [event.eventFingerprint],
          },
        });
      }),
    });
    const baseEnvironment = {
      GITHUB_EVENT_NAME: 'issues',
      GITHUB_EVENT_PATH: new URL('./fixtures/events/issue-opened.json', import.meta.url).pathname,
      GITHUB_RUN_ID: '100',
    };

    for (const attempt of ['1', '2']) {
      await runAction(
        { ...baseEnvironment, GITHUB_RUN_ATTEMPT: attempt },
        { dependencies: setup.value, stdout: { write: () => true } },
      );
    }

    expect(deliveryIds).toEqual(['workflow-run:100', 'workflow-run:100']);
  });

  it('returns a duplicate event no-op before model, lease, or mutation capabilities are used', async () => {
    const setup = dependencies({
      readRoutingState: vi.fn(async (event) =>
        routingSnapshot({
          ledger: {
            failureCount: 0,
            generation: 0,
            modelEventCount: 0,
            processedEventFingerprints: [event.eventFingerprint],
          },
        }),
      ),
    });

    const result = await runTriageAction(request(), setup.value);

    expect(result).toMatchObject({ reasonCode: 'duplicate_event', status: 'noop' });
    expect(setup.value.loadModelInputs).not.toHaveBeenCalled();
    expect(setup.value.inspectModelCapabilities).not.toHaveBeenCalled();
    expect(setup.value.acquireLease).not.toHaveBeenCalled();
    expect(setup.value.executeRoute).not.toHaveBeenCalled();
    expect(setup.value.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    ['report', 'needs_reproduction'],
    ['proposal', 'fix_pending'],
    ['transition', 'fix_verified'],
  ] as const)('repairs a partial %s marker without rerunning the model', async (kind, state) => {
    const setup = dependencies({
      executeRoute: vi.fn(async () => ({
        reasonCode: 'PARTIAL_RECONCILIATION_RECOVERED',
        state,
      })),
      readRoutingState: vi.fn(async () =>
        routingSnapshot({
          recovery: {
            generation: 1,
            kind: 'recover',
            recoveryKind: kind,
            state,
          },
        }),
      ),
    });

    const result = await runTriageAction(request(), setup.value);

    expect(result).toMatchObject({ route: 'recover', state });
    expect(setup.value.loadModelInputs).not.toHaveBeenCalled();
    expect(setup.value.inspectModelCapabilities).not.toHaveBeenCalled();
    expect(setup.value.createModelRuntime).not.toHaveBeenCalled();
    expect(setup.value.executeRoute).toHaveBeenCalledWith(
      expect.objectContaining({ route: expect.objectContaining({ kind: 'recover' }) }),
    );
  });

  it('runs close cleanup without provider, skill, workspace, or sandbox capabilities', async () => {
    const setup = dependencies({
      createModelRuntime: vi.fn(async () => {
        throw new Error('model runtime must not be created');
      }),
      loadModelInputs: vi.fn(async () => {
        throw new Error('model inputs must not be read');
      }),
    });

    const result = await runTriageAction(request(closed), setup.value);

    expect(result).toMatchObject({ route: 'cleanup', status: 'completed' });
    expect(setup.value.inspectModelCapabilities).not.toHaveBeenCalled();
    expect(setup.value.createModelRuntime).not.toHaveBeenCalled();
    expect(setup.lease.release).toHaveBeenCalledOnce();
  });

  it('uses identity-only preflight for lifecycle conflicts', async () => {
    const conflictPayload = structuredClone(closed) as {
      action: string;
      comment?: Record<string, unknown>;
      issue: { labels: { name: string }[]; state: string };
    };
    conflictPayload.action = 'created';
    conflictPayload.issue.state = 'open';
    conflictPayload.issue.labels = [
      { name: 'triage: failed' },
      { name: 'triage: needs reproduction' },
    ];
    conflictPayload.comment = {
      author_association: 'MEMBER',
      body: 'retry',
      created_at: '2026-10-14T12:00:00Z',
      id: 5001,
      user: { id: 4001, login: 'maintainer', type: 'User' },
    };
    const setup = dependencies({
      readRoutingState: vi.fn(async () =>
        routingSnapshot({ branchProvenanceVerified: false, githubIdentityVerified: true }),
      ),
    });

    const result = await runTriageAction(
      { ...request(conflictPayload), eventName: 'issue_comment' },
      setup.value,
    );

    expect(result).toMatchObject({ route: 'conflict', status: 'completed' });
    expect(setup.value.loadModelInputs).not.toHaveBeenCalled();
  });

  it('rejects private model routes before reading provider configuration or mutating GitHub', async () => {
    const privatePayload = structuredClone(opened) as {
      repository: { visibility: string };
    };
    privatePayload.repository.visibility = 'private';
    const setup = dependencies();

    await expect(runTriageAction(request(privatePayload), setup.value)).rejects.toThrowError(
      'Model routes support public repositories only',
    );

    expect(setup.value.loadModelInputs).not.toHaveBeenCalled();
    expect(setup.value.acquireLease).not.toHaveBeenCalled();
    expect(setup.value.executeRoute).not.toHaveBeenCalled();
    expect(setup.value.reconcileFailure).not.toHaveBeenCalled();
    expect(setup.value.reconcile).not.toHaveBeenCalled();
  });

  it('fails selected model capability preflight before acquiring a lease or writing', async () => {
    const setup = dependencies({
      inspectModelCapabilities: vi.fn(async () => ({
        checkoutSafe: true,
        labelsPresent: true,
        prSkillPresent: true,
        sandboxAvailable: false,
        triageSkillPresent: true,
      })),
    });

    await expect(runTriageAction(request(), setup.value)).rejects.toThrowError(
      'Required Linux sandbox is unavailable',
    );

    expect(setup.value.acquireLease).not.toHaveBeenCalled();
    expect(setup.value.executeRoute).not.toHaveBeenCalled();
    expect(setup.value.reconcileFailure).not.toHaveBeenCalled();
    expect(setup.value.reconcile).not.toHaveBeenCalled();
  });

  it('reconciles one fenced failure after unexpected model execution errors', async () => {
    const reconcileFailure = vi.fn(async () => undefined);
    const setup = dependencies({
      executeRoute: vi.fn(async () => {
        throw new Error('MODEL_OUTPUT_CANARY unsafe detail');
      }),
      reconcileFailure,
    });

    await expect(runTriageAction(request(), setup.value)).rejects.toThrowError(
      'MODEL_OUTPUT_CANARY unsafe detail',
    );

    expect(reconcileFailure).toHaveBeenCalledOnce();
    expect(reconcileFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: setup.lease,
        reasonCode: 'ACTION_FAILED',
        route: expect.objectContaining({ kind: 'triage' }),
      }),
    );
    expect(setup.value.reconcile).not.toHaveBeenCalled();
    expect(setup.runtime.close).toHaveBeenCalledOnce();
    expect(setup.lease.release).toHaveBeenCalledOnce();
  });

  it('does not count model-runtime setup failures against the failure budget', async () => {
    const reconcileFailure = vi.fn(async () => undefined);
    const setup = dependencies({
      createModelRuntime: vi.fn(async () => {
        throw new Error('MODEL_RUNTIME_SETUP_FAILED');
      }),
      reconcileFailure,
    });

    await expect(runTriageAction(request(), setup.value)).rejects.toThrowError(
      'MODEL_RUNTIME_SETUP_FAILED',
    );

    expect(reconcileFailure).not.toHaveBeenCalled();
    expect(setup.value.executeRoute).not.toHaveBeenCalled();
    expect(setup.value.reconcile).not.toHaveBeenCalled();
    expect(setup.lease.release).toHaveBeenCalledOnce();
  });

  it('fails closed when reconciliation returns unbounded model-derived output', async () => {
    const setup = dependencies({
      reconcile: vi.fn(async ({ event, route }) => ({
        appId: 'triage-agent',
        issueNumber: event.issue.number,
        reasonCode: 'MODEL_OUTPUT_CANARY inject markdown',
        repository: event.repository.fullName,
        route: route.kind,
        state: 'fix_pending',
        status: 'completed',
      })) as ActionControllerDependencies['reconcile'],
    });

    await expect(runTriageAction(request(), setup.value)).rejects.toThrowError(
      'ACTION_RESULT_INVALID',
    );

    expect(setup.runtime.close).toHaveBeenCalledOnce();
    expect(setup.lease.release).toHaveBeenCalledOnce();
  });

  it('repairs a partial pull-request result through reconciliation without duplicating it', async () => {
    const pullRequests = new Map<string, string>([
      ['triagebot/fix-42', 'https://github.test/pr/1'],
    ]);
    const reconcile = vi.fn(async ({ event, execution: completed, route }) => {
      const branch = 'triagebot/fix-42';
      const prUrl = pullRequests.get(branch) ?? 'https://github.test/pr/1';
      pullRequests.set(branch, prUrl);
      return {
        appId: 'triage-agent' as const,
        issueNumber: event.issue.number,
        prUrl,
        reasonCode: completed.reasonCode,
        repository: event.repository.fullName,
        route: route.kind,
        state: completed.state,
        status: 'completed' as const,
      };
    });
    const setup = dependencies({ reconcile });

    const first = await runTriageAction(request(), setup.value);
    const second = await runTriageAction({ ...request(), deliveryId: 'delivery-2' }, setup.value);

    expect(first).toMatchObject({ prUrl: 'https://github.test/pr/1' });
    expect(second).toMatchObject({ prUrl: 'https://github.test/pr/1' });
    expect(pullRequests).toHaveLength(1);
  });

  it('closes model resources and releases the lease after cancellation', async () => {
    const abort = new AbortController();
    const setup = dependencies({
      executeRoute: vi.fn(async () => {
        abort.abort();
        throw new Error('MODEL_ABORTED');
      }),
    });

    await expect(
      runTriageAction({ ...request(), abortSignal: abort.signal }, setup.value),
    ).rejects.toThrowError('MODEL_ABORTED');

    expect(setup.runtime.close).toHaveBeenCalledOnce();
    expect(setup.lease.release).toHaveBeenCalledOnce();
    expect(vi.mocked(setup.runtime.close).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(setup.lease.release).mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('cancels the active Mastra run and prevents reconciliation after abort', async () => {
    const abort = new AbortController();
    const cancel = vi.fn(async () => undefined);
    const start = vi.fn(
      async () =>
        new Promise<never>(() => {
          abort.abort(new Error('SIGTERM'));
        }),
    );
    const reconcile = vi.fn();
    const setup = dependencies({
      executeRoute: vi.fn(async () => {
        await runRegisteredWorkflow(
          {
            getWorkflow: () => ({
              createRun: async () => ({ cancel, start }),
            }),
          },
          'triage-workflow',
          {},
          abort.signal,
        );
        throw new Error('MODEL_CONTINUED_AFTER_ABORT');
      }),
      reconcile,
    });

    await expect(
      runTriageAction({ ...request(), abortSignal: abort.signal }, setup.value),
    ).rejects.toThrowError('SIGTERM');
    expect(cancel).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith({
      inputData: {},
      tracingOptions: { hideInput: true, hideOutput: true },
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(setup.runtime.close).toHaveBeenCalledOnce();
  });
});
