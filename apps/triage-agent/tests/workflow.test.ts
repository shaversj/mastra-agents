import { Mastra } from '@mastra/core/mastra';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { appMetadata } from '../src/config/app.js';
import { proposalIdentity } from '../src/domain/proposal.js';
import {
  createTriageWorkflow,
  triageWorkflowInputSchema,
  type ModelInvocation,
  type ModelRequest,
} from '../src/mastra/workflows/triage.js';
import {
  createTriageCommentWorkflow,
  triageCommentInputSchema,
} from '../src/mastra/workflows/triage-comment.js';

type Script = Record<string, unknown | unknown[]>;

function scriptedModel(script: Script, calls: ModelRequest[] = []) {
  return {
    calls,
    invoke: async (request: ModelRequest): Promise<ModelInvocation> => {
      calls.push(request);
      const queued = script[request.phase];
      const next = Array.isArray(queued) ? queued.shift() : queued;
      return { object: next, toolCalls: [] };
    },
  };
}

const input: z.output<typeof triageWorkflowInputSchema> = {
  allowedPackageLabels: ['pkg:core'],
  allowedPriorityLabels: ['priority:high'],
  attemptId: 'attempt-1',
  autoPrOnFix: false,
  eventFingerprint: 'issues:opened:1:2:delivery-1',
  generation: 1,
  issue: {
    body: 'The command fails with exit code 1.',
    number: 42,
    reporterLogin: 'reporter',
    title: 'Command fails',
  },
  maxModelRetries: 1,
  maxStageSteps: 12,
  repository: {
    baseSha: 'a'.repeat(40),
    defaultBranch: 'main',
    fullName: 'owner/repo',
  },
  totalRunMs: 12 * 60_000,
};

async function runTriage(
  script: Script,
  inputData: z.output<typeof triageWorkflowInputSchema> = input,
) {
  const model = scriptedModel(script);
  const workflow = createTriageWorkflow({
    admitChanges: async () => true,
    collectEvidence: async ({ phase }) => [
      phase === 'verify'
        ? { kind: 'test', phase, status: 'passed' as const }
        : { kind: 'model_stage', phase, status: 'observed' as const },
    ],
    invokeModel: model.invoke,
  });
  const mastra = new Mastra({ workflows: { [appMetadata.workflowIds.triage]: workflow } });
  const run = await mastra.getWorkflow(appMetadata.workflowIds.triage).createRun();
  return { calls: model.calls, result: await run.start({ inputData }) };
}

describe('triage workflow', () => {
  it('forwards a bounded retriage comment into the model context', async () => {
    const triggeringComment = { body: 'Run npm test -- widget to reproduce.', id: 5001 };
    const { calls, result } = await runTriage(
      {
        reproduce: { decision: 'not_actionable', reasonCode: 'not_a_bug' },
        draft_report: { details: ['No supported bug was found.'], headline: 'Triage complete' },
      },
      { ...input, triggeringComment },
    );

    expect(result.status).toBe('success');
    expect(calls).not.toHaveLength(0);
    for (const call of calls) expect(call.payload).toMatchObject({ triggeringComment });
  });

  it.each([
    ['reproduce', { decision: 'not_actionable', reasonCode: 'not_a_bug' }, 'not_actionable'],
    [
      'reproduce',
      { decision: 'missing_reproduction', reasonCode: 'missing_steps' },
      'needs_reproduction',
    ],
    ['reproduce', { decision: 'skipped', reasonCode: 'unsupported_scope' }, 'skipped'],
    [
      'reproduce',
      { decision: 'unable_to_reproduce', reasonCode: 'reproduction_failed' },
      'unable_to_reproduce',
    ],
    ['diagnose', { decision: 'unable_to_fix', reasonCode: 'cause_unknown' }, 'unable_to_fix'],
    ['verify', { decision: 'unable_to_fix', reasonCode: 'verification_failed' }, 'unable_to_fix'],
    ['fix', { decision: 'unable_to_fix', reasonCode: 'fix_failed' }, 'unable_to_fix'],
  ] as const)('stops at the first valid %s outcome', async (phase, closure, state) => {
    const script: Script = {
      reproduce: { decision: 'continue' },
      diagnose: { decision: 'continue' },
      draft_report: {
        details: ['The issue reached a bounded triage outcome.'],
        headline: 'Triage complete',
      },
      verify: { decision: 'continue' },
      fix: { decision: 'verified_fix' },
    };
    script[phase] = closure;

    const { calls, result } = await runTriage(script);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toMatchObject({
        mutationPlan: {
          kind: 'triage_outcome',
          report: { headline: 'Triage complete' },
        },
        state,
        stoppedAt: phase,
      });
      expect(result.result.evidence).toEqual(
        expect.arrayContaining([expect.objectContaining({ phase })]),
      );
    }
    const order = ['reproduce', 'diagnose', 'fix', 'verify'];
    expect(calls.map(({ phase: called }) => called)).toEqual([
      ...order.slice(0, order.indexOf(phase) + 1),
      'draft_report',
    ]);
    expect(calls.at(-1)).toMatchObject({ activeTools: [], phase: 'draft_report' });
  });

  it('admits a verified proposal only after evidence and deterministic admission', async () => {
    const { calls, result } = await runTriage({
      reproduce: { decision: 'continue' },
      diagnose: { decision: 'continue' },
      verify: { decision: 'continue' },
      fix: { decision: 'verified_fix' },
      classify_outcome: { decision: 'verified_fix' },
      draft_report: { headline: 'A verified fix is ready', details: ['Run the reported command.'] },
      select_labels: { packageLabels: ['pkg:core'], priorityLabel: 'priority:high' },
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toMatchObject({
        state: 'fix_pending',
        mutationPlan: expect.objectContaining({ kind: 'publish_proposal' }),
        stoppedAt: 'admission',
      });
    }
    for (const phase of ['classify_outcome', 'draft_report', 'select_labels']) {
      expect(calls.find((call) => call.phase === phase)).toMatchObject({
        activeTools: [],
      });
    }
  });

  it('collects trusted verification evidence only after the fix is applied', async () => {
    let fixApplied = false;
    const phases: string[] = [];
    const workflow = createTriageWorkflow({
      admitChanges: async () => true,
      collectEvidence: async ({ phase }) => {
        phases.push(phase);
        if (phase === 'fix') fixApplied = true;
        if (phase === 'verify') {
          return [{ kind: 'test', phase, status: fixApplied ? 'passed' : 'failed' }];
        }
        return [{ kind: 'model_stage', phase, status: 'observed' }];
      },
      invokeModel: scriptedModel({
        reproduce: { decision: 'continue' },
        diagnose: { decision: 'continue' },
        fix: { decision: 'verified_fix' },
        verify: { decision: 'continue' },
        classify_outcome: { decision: 'verified_fix' },
        draft_report: {
          headline: 'A post-fix verification passed',
          details: ['The trusted test ran after the edit phase.'],
        },
        select_labels: { packageLabels: ['pkg:core'], priorityLabel: 'priority:high' },
      }).invoke,
    });
    const mastra = new Mastra({ workflows: { [appMetadata.workflowIds.triage]: workflow } });
    const run = await mastra.getWorkflow(appMetadata.workflowIds.triage).createRun();
    const result = await run.start({ inputData: input });

    expect(phases).toEqual(['reproduce', 'diagnose', 'fix', 'verify']);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toMatchObject({
        mutationPlan: expect.objectContaining({ kind: 'publish_proposal' }),
        state: 'fix_pending',
      });
      expect(result.result.evidence).toContainEqual({
        kind: 'test',
        phase: 'verify',
        status: 'passed',
      });
    }
  });

  it('drafts tool-less PR content only when automatic PR creation is selected', async () => {
    const model = scriptedModel({
      reproduce: { decision: 'continue' },
      diagnose: { decision: 'continue' },
      verify: { decision: 'continue' },
      fix: { decision: 'verified_fix' },
      classify_outcome: { decision: 'verified_fix' },
      draft_report: { headline: 'A verified fix is ready', details: ['Run the reported command.'] },
      select_labels: { packageLabels: ['pkg:core'], priorityLabel: 'priority:high' },
      draft_pr_content: { bodyFields: ['Fixes the failure.'], title: 'Fix command failure' },
    });
    const workflow = createTriageWorkflow({
      admitChanges: async () => true,
      collectEvidence: async ({ phase }) => [
        phase === 'verify'
          ? { kind: 'test', phase, status: 'passed' as const }
          : { kind: 'model_stage', phase, status: 'observed' as const },
      ],
      invokeModel: model.invoke,
      prSkill: 'pr-skill',
    });
    const mastra = new Mastra({ workflows: { [appMetadata.workflowIds.triage]: workflow } });
    const run = await mastra.getWorkflow(appMetadata.workflowIds.triage).createRun();
    const result = await run.start({ inputData: { ...input, autoPrOnFix: true } });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result.mutationPlan).toMatchObject({
        kind: 'publish_proposal',
        prContent: { title: 'Fix command failure' },
      });
    }
    expect(model.calls.find(({ phase }) => phase === 'draft_pr_content')).toMatchObject({
      activeTools: [],
      skill: 'pr-skill',
    });
  });

  it('rejects model-provided branch identity and defaults admission to fail closed', async () => {
    const workflow = createTriageWorkflow({
      collectEvidence: async ({ phase }) => [
        phase === 'verify'
          ? { kind: 'test', phase, status: 'passed' as const }
          : { kind: 'model_stage', phase, status: 'observed' as const },
      ],
      invokeModel: scriptedModel({
        reproduce: { decision: 'continue' },
        diagnose: { decision: 'continue' },
        verify: { decision: 'continue' },
        fix: {
          decision: 'verified_fix',
          proposal: {
            baseSha: 'a'.repeat(40),
            branch: 'triagebot/fix-42',
            headSha: 'b'.repeat(40),
          },
        },
      }).invoke,
    });
    const mastra = new Mastra({ workflows: { [appMetadata.workflowIds.triage]: workflow } });
    const run = await mastra.getWorkflow(appMetadata.workflowIds.triage).createRun();
    const rejectedIdentity = await run.start({ inputData: input });

    expect(rejectedIdentity.status).toBe('success');
    if (rejectedIdentity.status === 'success') {
      expect(rejectedIdentity.result).toMatchObject({
        failureCode: 'MALFORMED_STRUCTURED_OUTPUT',
        mutationPlan: null,
      });
    }

    const noAdmission = createTriageWorkflow({
      collectEvidence: async ({ phase }) => [
        phase === 'verify'
          ? { kind: 'test', phase, status: 'passed' as const }
          : { kind: 'model_stage', phase, status: 'observed' as const },
      ],
      invokeModel: scriptedModel({
        reproduce: { decision: 'continue' },
        diagnose: { decision: 'continue' },
        verify: { decision: 'continue' },
        fix: { decision: 'verified_fix' },
        classify_outcome: { decision: 'verified_fix' },
      }).invoke,
    });
    const noAdmissionMastra = new Mastra({ workflows: { workflow: noAdmission } });
    const noAdmissionRun = await noAdmissionMastra.getWorkflow('workflow').createRun();
    const rejectedAdmission = await noAdmissionRun.start({ inputData: input });
    expect(rejectedAdmission.status).toBe('success');
    if (rejectedAdmission.status === 'success') {
      expect(rejectedAdmission.result).toMatchObject({
        failureCode: 'ADMISSION_REJECTED',
        mutationPlan: null,
      });
    }
  });

  it('rejects a verified fix without passed trusted verification evidence', async () => {
    const workflow = createTriageWorkflow({
      admitChanges: async () => true,
      collectEvidence: async ({ phase }) => [
        { kind: 'command', phase, status: phase === 'verify' ? 'failed' : 'passed' },
      ],
      invokeModel: scriptedModel({
        reproduce: { decision: 'continue' },
        diagnose: { decision: 'continue' },
        verify: { decision: 'continue' },
        fix: { decision: 'verified_fix' },
        classify_outcome: { decision: 'verified_fix' },
      }).invoke,
    });
    const mastra = new Mastra({ workflows: { workflow } });
    const run = await mastra.getWorkflow('workflow').createRun();
    const result = await run.start({ inputData: input });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toMatchObject({
        failureCode: 'ADMISSION_REJECTED',
        mutationPlan: null,
      });
    }
  });

  it('fails closed on malformed structured output and produces no mutation plan', async () => {
    const { result } = await runTriage({ reproduce: { anything: 'fallback-shaped' } });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toMatchObject({
        failureCode: 'MALFORMED_STRUCTURED_OUTPUT',
        mutationPlan: null,
        state: 'failed',
      });
    }
  });

  it('fails closed when a tool-less model attempts a tool call', async () => {
    const invokeModel = async (request: ModelRequest): Promise<ModelInvocation> => ({
      object:
        request.phase === 'classify_outcome'
          ? { decision: 'verified_fix' }
          : request.phase === 'fix'
            ? { decision: 'verified_fix' }
            : { decision: 'continue' },
      toolCalls: request.phase === 'classify_outcome' ? [{ name: 'write_file' }] : [],
    });
    const workflow = createTriageWorkflow({
      admitChanges: async () => true,
      collectEvidence: async ({ phase }) => [
        phase === 'verify'
          ? { kind: 'test', phase, status: 'passed' as const }
          : { kind: 'model_stage', phase, status: 'observed' as const },
      ],
      invokeModel,
    });
    const mastra = new Mastra({ workflows: { [appMetadata.workflowIds.triage]: workflow } });
    const run = await mastra.getWorkflow(appMetadata.workflowIds.triage).createRun();
    const result = await run.start({ inputData: input });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toMatchObject({
        failureCode: 'TOOL_CALL_ATTEMPTED',
        mutationPlan: null,
        state: 'failed',
      });
    }
  });

  it.each([
    [
      'provider retry budget exhausted',
      new Error('provider unavailable'),
      'MODEL_RETRIES_EXHAUSTED',
    ],
    [
      'total model budget timed out',
      new Error('request timed out: hostile issue body'),
      'MODEL_TIMEOUT',
    ],
  ] as const)('returns a bounded failure when %s', async (_case, error, failureCode) => {
    const workflow = createTriageWorkflow({
      collectEvidence: async () => [],
      invokeModel: async () => Promise.reject(error),
    });
    const mastra = new Mastra({ workflows: { [appMetadata.workflowIds.triage]: workflow } });
    const run = await mastra.getWorkflow(appMetadata.workflowIds.triage).createRun();
    const result = await run.start({ inputData: input });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toMatchObject({ failureCode, mutationPlan: null, state: 'failed' });
      expect(JSON.stringify(result.result)).not.toContain('hostile issue body');
    }
  });
});

describe('comment workflow', () => {
  const proposal = proposalIdentity({
    baseSha: 'a'.repeat(40),
    branch: 'triagebot/fix-42',
    headSha: 'b'.repeat(40),
  });

  it('bounds issue context before confirmation-time PR drafting', () => {
    const base = {
      actor: { association: 'NONE' as const, login: 'reporter' },
      issue: {
        body: 'A bounded issue body',
        number: 42,
        reporterLogin: 'reporter',
        title: 'A bounded issue title',
      },
      proposal,
      remoteHeadSha: proposal.headSha,
      route: 'confirmation' as const,
      triggeringComment: { body: 'confirm', id: 100 },
    };

    expect(triageCommentInputSchema.safeParse(base).success).toBe(true);
    expect(
      triageCommentInputSchema.safeParse({
        ...base,
        issue: { ...base.issue, body: 'x'.repeat(65_537) },
      }).success,
    ).toBe(false);
    expect(
      triageCommentInputSchema.safeParse({
        ...base,
        issue: { ...base.issue, title: 'x'.repeat(1_025) },
      }).success,
    ).toBe(false);
  });

  async function runComment(
    route: 'confirmation' | 'retriage',
    response: unknown,
    overrides: Record<string, unknown> = {},
  ) {
    const model = scriptedModel({
      [route === 'confirmation' ? 'classify_confirmation' : 'classify_retriage']: response,
      draft_pr_content: {
        bodyFields: ['Fixes the reported failure.'],
        title: 'Fix command failure',
      },
    });
    const workflow = createTriageCommentWorkflow({
      invokeModel: model.invoke,
      prSkill: 'pr-skill',
    });
    const mastra = new Mastra({ workflows: { [appMetadata.workflowIds.comment]: workflow } });
    const run = await mastra.getWorkflow(appMetadata.workflowIds.comment).createRun();
    const result = await run.start({
      inputData: {
        actor: { association: 'NONE', login: 'reporter' },
        issue: {
          body: 'The widget command fails after the latest release.',
          number: 42,
          reporterLogin: 'reporter',
          title: 'Widget command fails',
        },
        maxModelRetries: 1,
        maxStageSteps: 4,
        proposal,
        remoteHeadSha: proposal.headSha,
        route,
        triggeringComment: { body: 'please retry', id: 100 },
        totalRunMs: 4 * 60_000,
        ...overrides,
      },
    });
    return { calls: model.calls, result };
  }

  it('binds retriage classification to the triggering comment', async () => {
    const { result } = await runComment('retriage', { commentId: 101, decision: 'retry' });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toMatchObject({
        action: 'none',
        reasonCode: 'COMMENT_BINDING_MISMATCH',
      });
    }
  });

  it.each([
    ['confirmed', 'create_pull_request'],
    ['rejected', 'reject_proposal'],
    ['inconclusive', 'none'],
  ] as const)(
    'applies deterministic %s actor and proposal checks',
    async (classification, action) => {
      const { result } = await runComment('confirmation', {
        classification,
        commentId: 100,
        mentionedProposalId: proposal.id,
      });
      expect(result.status).toBe('success');
      if (result.status === 'success') expect(result.result.action).toBe(action);
    },
  );

  it('loads the optional PR skill only for tool-less PR content', async () => {
    const { calls } = await runComment('confirmation', {
      classification: 'confirmed',
      commentId: 100,
      mentionedProposalId: proposal.id,
    });
    const confirmationCall = calls.find(({ phase }) => phase === 'classify_confirmation');
    expect(confirmationCall).toMatchObject({ activeTools: [] });
    expect(confirmationCall).not.toHaveProperty('skill');
    const draftCall = calls.find(({ phase }) => phase === 'draft_pr_content');
    expect(draftCall).toMatchObject({ activeTools: [], skill: 'pr-skill' });
    expect(draftCall?.payload).toEqual({
      issue: {
        body: 'The widget command fails after the latest release.',
        number: 42,
        title: 'Widget command fails',
      },
      proposal: {
        branch: proposal.branch,
        headSha: proposal.headSha,
        id: proposal.id,
        verificationStatus: 'verified',
      },
    });
  });

  it('keeps an unrelated participant and mismatched proposal responses inconclusive', async () => {
    const unrelated = await runComment(
      'confirmation',
      { classification: 'confirmed', commentId: 100, mentionedProposalId: proposal.id },
      { actor: { association: 'NONE', login: 'someone-else' } },
    );
    const missingId = await runComment('confirmation', {
      classification: 'confirmed',
      commentId: 100,
    });
    const stale = await runComment(
      'confirmation',
      { classification: 'confirmed', commentId: 100, mentionedProposalId: proposal.id },
      { remoteHeadSha: 'c'.repeat(40) },
    );

    for (const run of [unrelated, missingId, stale]) {
      expect(run.result.status).toBe('success');
      if (run.result.status === 'success') {
        expect(run.result.result).toMatchObject({ action: 'none', state: 'fix_pending' });
      }
      expect(run.calls.some(({ phase }) => phase === 'draft_pr_content')).toBe(false);
    }
    expect(unrelated.calls).toHaveLength(0);
    expect(stale.calls).toHaveLength(0);
    expect(missingId.calls.map(({ phase }) => phase)).toEqual(['classify_confirmation']);
  });

  it('fails closed when a comment classifier attempts a tool call', async () => {
    const workflow = createTriageCommentWorkflow({
      invokeModel: async () => ({
        object: { commentId: 100, decision: 'retry' },
        toolCalls: [{ name: 'history_log' }],
      }),
    });
    const mastra = new Mastra({ workflows: { [appMetadata.workflowIds.comment]: workflow } });
    const run = await mastra.getWorkflow(appMetadata.workflowIds.comment).createRun();
    const result = await run.start({
      inputData: {
        actor: { association: 'NONE', login: 'reporter' },
        issue: {
          body: 'The widget command fails after the latest release.',
          number: 42,
          reporterLogin: 'reporter',
          title: 'Widget command fails',
        },
        maxModelRetries: 1,
        maxStageSteps: 4,
        proposal,
        remoteHeadSha: proposal.headSha,
        route: 'retriage',
        totalRunMs: 4 * 60_000,
        triggeringComment: { body: 'retry', id: 100 },
      },
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.result).toMatchObject({ action: 'none', reasonCode: 'TOOL_CALL_ATTEMPTED' });
    }
  });
});
