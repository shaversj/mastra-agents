import { describe, expect, it } from 'vitest';

import { parseActionInputs } from '../src/action/inputs.js';
import { preflightAction } from '../src/action/preflight.js';
import { appMetadata } from '../src/config/app.js';

const validEnvironment = {
  INPUT_READ_TOKEN: 'read-secret',
  INPUT_WRITE_TOKEN: 'write-secret',
  INPUT_ANTHROPIC_API_KEY: 'provider-secret',
  INPUT_TRIAGE_SKILL: '.agents/skills/triage',
};

describe('triage Action configuration', () => {
  it('owns stable app and Mastra registry identities', () => {
    expect(appMetadata).toEqual({
      agentId: 'triage-coding-agent',
      appId: 'triage-agent',
      packageName: '@mastra-agents/triage-agent',
      scorerId: 'triage-release-gate',
      workflowIds: {
        comment: 'triage-comment-workflow',
        triage: 'triage-workflow',
      },
    });
  });

  it('preserves compatibility defaults and secure extension defaults', () => {
    expect(parseActionInputs(validEnvironment)).toMatchObject({
      activationPolicy: 'automatic-public',
      allowDownstreamWorkflows: false,
      autoPrOnFix: false,
      botLogins: ['github-actions[bot]'],
      labels: {
        failed: 'triage: failed',
        fix_pending: 'triage: fix pending',
        fix_rejected: 'triage: fix rejected',
        fix_verified: 'triage: fix verified',
        needs_reproduction: 'triage: needs reproduction',
        needs_triage: 'triage: needs triage',
        not_actionable: 'triage: not actionable',
        skipped: 'triage: skipped',
        unable_to_fix: 'triage: unable to fix',
        unable_to_reproduce: 'triage: unable to reproduce',
      },
      maxModelEvents: 4,
      previewAllowedHosts: [],
      prFixVerifiedLabel: 'fix verified',
      publicationTokenKind: 'github-token',
      safeDownstreamCi: false,
      triageModel: 'anthropic/claude-opus-4-6',
      verificationModel: 'anthropic/claude-sonnet-4-6',
    });
  });

  it('accepts legacy underscore environment names', () => {
    expect(
      parseActionInputs({
        ...validEnvironment,
        INPUT_AUTO_PR_ON_FIX: 'true',
      }),
    ).toMatchObject({ autoPrOnFix: true });
  });

  it('rejects duplicate labels, invalid limits, and invalid preview hosts', () => {
    expect(() =>
      parseActionInputs({
        ...validEnvironment,
        INPUT_LABEL_FAILED: 'triage: needs triage',
      }),
    ).toThrowError('Action inputs contain duplicate lifecycle labels');

    expect(() =>
      parseActionInputs({ ...validEnvironment, INPUT_MAX_MODEL_EVENTS: '0' }),
    ).toThrowError('Invalid Action input: max-model-events');

    expect(() =>
      parseActionInputs({
        ...validEnvironment,
        INPUT_PREVIEW_ALLOWED_HOSTS: 'https://preview.example.com/path',
      }),
    ).toThrowError('Invalid Action input: preview-allowed-hosts');
  });

  it('requires complete provider and elevated-publication pairs', () => {
    expect(() =>
      parseActionInputs({
        ...validEnvironment,
        INPUT_ANTHROPIC_API_KEY: '',
        INPUT_CLOUDFLARE_API_KEY: 'provider-secret',
      }),
    ).toThrowError('Missing required Action input: cloudflare-account-id');

    expect(() =>
      parseActionInputs({
        ...validEnvironment,
        INPUT_PUBLICATION_TOKEN_KIND: 'workflow-triggering',
      }),
    ).toThrowError('Invalid downstream workflow configuration');
  });

  it('fails model-route preflight for non-public repositories', () => {
    const inputs = parseActionInputs(validEnvironment);

    expect(() =>
      preflightAction(inputs, { repositoryVisibility: 'private', route: 'model' }),
    ).toThrowError('Model routes support public repositories only');
  });

  it('never echoes token values in configuration errors', () => {
    const secret = 'provider-secret-never-print';

    try {
      parseActionInputs({
        ...validEnvironment,
        INPUT_ANTHROPIC_API_KEY: '',
        INPUT_OPENAI_API_KEY: '',
        INPUT_WRITE_TOKEN: secret,
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
