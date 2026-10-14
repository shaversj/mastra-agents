import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { projectGitHubEvent } from '../src/domain/event-projection.js';
import {
  defaultLifecycleLabels,
  evaluateRoute,
  reconcileLifecycleLabels,
  selectAllowedAncillaryLabels,
  transitionLifecycle,
  type AttemptLedger,
  type LifecycleState,
} from '../src/domain/lifecycle.js';
import { loadBoundedCommentWindow, selectCommentWindow } from '../src/github/read-client.js';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/events/${name}.json`, import.meta.url), 'utf8'),
  );
}

const emptyLedger: AttemptLedger = {
  failureCount: 0,
  generation: 2,
  modelEventCount: 0,
  processedEventFingerprints: [],
};

describe('GitHub event projection and lifecycle routing', () => {
  it('preserves trusted identities and the triggering comment', () => {
    const event = projectGitHubEvent('issue_comment', fixture('comment-created'), 'delivery-1');

    expect(event).toMatchObject({
      action: 'created',
      actor: { id: 3001, login: 'reporter' },
      comment: { id: 5001 },
      deliveryId: 'delivery-1',
      issue: { id: 2001, number: 42, reporterLogin: 'reporter' },
      kind: 'issue_comment',
      repository: { fullName: 'example/widgets', id: 1001, visibility: 'public' },
    });
    expect(event.eventFingerprint).toBe('issue_comment:created:1001:2001:5001:delivery-1');
  });

  it('does not project an issue author association onto a different event sender', () => {
    const payload = fixture('issue-reopened') as Record<string, unknown>;
    const issue = payload.issue as Record<string, unknown>;
    const event = projectGitHubEvent(
      'issues',
      {
        ...payload,
        issue: { ...issue, author_association: 'OWNER' },
        sender: { id: 9001, login: 'reopener', type: 'User' },
      },
      'delivery-reopened-by-other',
    );

    expect(event.actor).toMatchObject({ association: 'NONE', id: 9001, login: 'reopener' });
  });

  it('selects the triggering comment instead of a later API result', () => {
    const selected = selectCommentWindow(
      [
        { authorLogin: 'reporter', body: 'trigger', id: 5001 },
        { authorLogin: 'other', body: 'later', id: 5002 },
      ],
      { maxComments: 2, triggerCommentId: 5001 },
    );

    expect(selected.triggeringComment.body).toBe('trigger');
    expect(selected.comments.map(({ id }) => id)).toEqual([5001, 5002]);
  });

  it('bounds paging while retaining the trigger and authenticated active marker', async () => {
    const pages = [
      [{ authorLogin: 'triage-action', body: '<!-- marker -->', id: 4999 }],
      [{ authorLogin: 'reporter', body: 'trigger', id: 5001 }],
      [{ authorLogin: 'other', body: 'must not be read', id: 5002 }],
    ];
    const result = await loadBoundedCommentWindow({
      isActiveMarker: ({ authorLogin, body }) =>
        authorLogin === 'triage-action' && body.includes('<!-- marker -->'),
      fetchPage: async (page) => pages[page - 1] ?? [],
      maxComments: 2,
      maxPages: 3,
      triggerCommentId: 5001,
    });

    expect(result).toMatchObject({
      activeMarkerComment: { id: 4999 },
      pagesRead: 2,
      triggeringComment: { id: 5001 },
    });
  });

  it('admits only configured ancillary labels within cardinality limits', () => {
    expect(
      selectAllowedAncillaryLabels({
        allowedPackageLabels: ['pkg:a', 'pkg:b', 'pkg:c', 'pkg:d'],
        allowedPriorityLabels: ['p1'],
        requestedPackageLabels: ['pkg:a', 'not-allowed', 'pkg:b', 'pkg:c', 'pkg:d'],
        requestedPriorityLabel: 'p1',
      }),
    ).toEqual({ packageLabels: ['pkg:a', 'pkg:b', 'pkg:c'], priorityLabel: 'p1' });
  });

  it('maps absent, unique, and conflicting lifecycle labels explicitly', () => {
    expect(reconcileLifecycleLabels([], defaultLifecycleLabels)).toEqual({ kind: 'missing' });
    expect(
      reconcileLifecycleLabels(['triage: needs reproduction'], defaultLifecycleLabels),
    ).toEqual({
      kind: 'current',
      label: 'triage: needs reproduction',
      state: 'needs_reproduction',
    });
    expect(
      reconcileLifecycleLabels(
        ['triage: needs reproduction', 'triage: failed'],
        defaultLifecycleLabels,
      ),
    ).toMatchObject({ kind: 'conflict', states: ['needs_reproduction', 'failed'] });
  });

  it('routes supported issue events with fresh generations for open and reopen', () => {
    for (const name of ['issue-opened', 'issue-reopened'] as const) {
      const event = projectGitHubEvent('issues', fixture(name), `delivery-${name}`);
      expect(
        evaluateRoute({
          activationPolicy: 'automatic-public',
          event,
          ledger: { ...emptyLedger, failureCount: 3, modelEventCount: 99 },
          lifecycleLabels: defaultLifecycleLabels,
          maxModelEvents: 4,
        }),
      ).toMatchObject({ kind: 'triage', generation: 3, resetBudgets: true });
    }
  });

  it('supports hardened activation without narrowing automatic-public behavior', () => {
    const event = projectGitHubEvent('issues', fixture('issue-opened'), 'delivery-hardened');
    expect(
      evaluateRoute({
        activationPolicy: 'automatic-public',
        event,
        ledger: emptyLedger,
        lifecycleLabels: defaultLifecycleLabels,
        maxModelEvents: 4,
      }).kind,
    ).toBe('triage');
    expect(
      evaluateRoute({
        activationPolicy: 'trusted',
        event,
        ledger: emptyLedger,
        lifecycleLabels: defaultLifecycleLabels,
        maxModelEvents: 4,
      }),
    ).toEqual({ kind: 'noop', reason: 'awaiting_trusted_activation' });
    expect(
      evaluateRoute({
        activationPolicy: 'trusted',
        event,
        ledger: emptyLedger,
        lifecycleLabels: defaultLifecycleLabels,
        maxModelEvents: 4,
        trustedActivation: true,
      }).kind,
    ).toBe('triage');
  });

  it('suppresses duplicate deliveries and exhausted generation budgets', () => {
    const event = projectGitHubEvent('issue_comment', fixture('comment-created'), 'delivery-1');
    const base = {
      activationPolicy: 'automatic-public' as const,
      event,
      lifecycleLabels: defaultLifecycleLabels,
      maxModelEvents: 4,
    };

    expect(
      evaluateRoute({
        ...base,
        ledger: { ...emptyLedger, processedEventFingerprints: [event.eventFingerprint] },
      }),
    ).toEqual({ kind: 'noop', reason: 'duplicate_event' });
    expect(evaluateRoute({ ...base, ledger: { ...emptyLedger, failureCount: 3 } })).toEqual({
      kind: 'noop',
      reason: 'failure_budget_exhausted',
    });
    expect(evaluateRoute({ ...base, ledger: { ...emptyLedger, modelEventCount: 4 } })).toEqual({
      kind: 'noop',
      reason: 'model_event_budget_exhausted',
    });
  });

  it('lets only a trusted reset renew an exhausted open generation', () => {
    const projected = projectGitHubEvent(
      'issue_comment',
      fixture('comment-created'),
      'delivery-reset',
    );
    const event = {
      ...projected,
      issue: { ...projected.issue, labels: [defaultLifecycleLabels.needs_triage] },
    };
    const exhausted = { ...emptyLedger, failureCount: 3, modelEventCount: 4 };

    expect(
      evaluateRoute({
        activationPolicy: 'automatic-public',
        event,
        ledger: exhausted,
        lifecycleLabels: defaultLifecycleLabels,
        maxModelEvents: 4,
        trustedReset: true,
      }),
    ).toMatchObject({ kind: 'triage', generation: 3, resetBudgets: true });
  });

  it('returns closed no-op and cleanup routes', () => {
    const closed = projectGitHubEvent('issues', fixture('issue-closed'), 'delivery-close');
    expect(
      evaluateRoute({
        activationPolicy: 'automatic-public',
        event: closed,
        ledger: emptyLedger,
        lifecycleLabels: defaultLifecycleLabels,
        maxModelEvents: 4,
      }),
    ).toEqual({ kind: 'cleanup', issueNumber: 42 });

    const comment = projectGitHubEvent('issue_comment', fixture('comment-created'), 'delivery-bot');
    expect(
      evaluateRoute({
        actionLogin: 'github-actions[bot]',
        activationPolicy: 'automatic-public',
        botLogins: ['renovate[bot]'],
        event: { ...comment, actor: { ...comment.actor, login: 'github-actions[bot]' } },
        ledger: emptyLedger,
        lifecycleLabels: defaultLifecycleLabels,
        maxModelEvents: 4,
      }),
    ).toEqual({ kind: 'noop', reason: 'bot_comment' });
  });

  it('uses the same state keys for custom labels and validates legal transitions', () => {
    const custom = Object.fromEntries(
      Object.keys(defaultLifecycleLabels).map((key) => [key, `custom:${key}`]),
    ) as typeof defaultLifecycleLabels;
    const states = Object.keys(defaultLifecycleLabels) as LifecycleState[];

    for (const state of states) {
      expect(reconcileLifecycleLabels([custom[state]], custom)).toMatchObject({ state });
    }
    expect(transitionLifecycle('needs_triage', 'needs_reproduction')).toEqual({
      kind: 'transition',
      state: 'needs_reproduction',
    });
    expect(transitionLifecycle('fix_verified', 'needs_triage')).toEqual({
      from: 'fix_verified',
      kind: 'illegal_transition',
      to: 'needs_triage',
    });
  });

  it.each([
    ['needs_triage', 'noop'],
    ['not_actionable', 'noop'],
    ['needs_reproduction', 'classify_retriage'],
    ['skipped', 'noop'],
    ['unable_to_reproduce', 'classify_retriage'],
    ['unable_to_fix', 'classify_retriage'],
    ['failed', 'classify_retriage'],
    ['fix_pending', 'classify_fix_response'],
    ['fix_rejected', 'classify_retriage'],
    ['fix_verified', 'noop'],
  ] as const)('closes the comment route for lifecycle state %s', (state, expectedKind) => {
    const projected = projectGitHubEvent(
      'issue_comment',
      fixture('comment-created'),
      `delivery-${state}`,
    );
    const event = {
      ...projected,
      issue: { ...projected.issue, labels: [defaultLifecycleLabels[state]] },
    };
    const route = (labels: typeof defaultLifecycleLabels) =>
      evaluateRoute({
        activationPolicy: 'automatic-public',
        event: { ...event, issue: { ...event.issue, labels: [labels[state]] } },
        ledger: emptyLedger,
        lifecycleLabels: labels,
        maxModelEvents: 4,
      }).kind;
    const custom = Object.fromEntries(
      Object.keys(defaultLifecycleLabels).map((key) => [key, `custom:${key}`]),
    ) as typeof defaultLifecycleLabels;
    expect(route(defaultLifecycleLabels)).toBe(expectedKind);
    expect(route(custom)).toBe(expectedKind);
  });
});
