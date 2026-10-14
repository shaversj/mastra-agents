import { z } from 'zod';

import {
  defaultLifecycleLabels,
  lifecycleStates,
  type LifecycleLabels,
  type LifecycleState,
} from '../domain/lifecycle.js';

type Environment = Readonly<Record<string, string | undefined>>;

const booleanSchema = z.enum(['true', 'false']);
const activationPolicySchema = z.enum(['automatic-public', 'trusted']);
const publicationTokenKindSchema = z.enum(['github-token', 'workflow-triggering']);
const lifecycleLabelInputs: Readonly<Record<LifecycleState, string>> = {
  failed: 'label-failed',
  fix_pending: 'label-fix-pending',
  fix_rejected: 'label-fix-rejected',
  fix_verified: 'label-fix-verified',
  needs_reproduction: 'label-needs-reproduction',
  needs_triage: 'label-needs-triage',
  not_actionable: 'label-not-actionable',
  skipped: 'label-skipped',
  unable_to_fix: 'label-unable-to-fix',
  unable_to_reproduce: 'label-unable-to-reproduce',
};

export interface ActionInputs {
  activationPolicy: z.infer<typeof activationPolicySchema>;
  allowDownstreamWorkflows: boolean;
  allowedPackageLabels: string[];
  allowedPriorityLabels: string[];
  anthropicApiKey?: string;
  autoPrOnFix: boolean;
  botLogins: string[];
  buildCommand?: string;
  cloudflareAccountId?: string;
  cloudflareApiKey?: string;
  labels: LifecycleLabels;
  maxModelEvents: number;
  openaiApiKey?: string;
  previewAllowedHosts: string[];
  previewCommand?: string;
  prFixVerifiedLabel: string;
  prSkill?: string;
  prSkillName: string;
  publicationTokenKind: z.infer<typeof publicationTokenKindSchema>;
  readToken: string;
  safeDownstreamCi: boolean;
  triageModel: string;
  triageSkill: string;
  verificationModel: string;
  writeToken: string;
}

function getInput(environment: Environment, name: string): string {
  const canonicalName = `INPUT_${name.replaceAll(' ', '_').toUpperCase()}`;
  const legacyName = `INPUT_${name.replaceAll(/[- ]/gu, '_').toUpperCase()}`;
  return (environment[canonicalName] ?? environment[legacyName] ?? '').trim();
}

function requiredInput(environment: Environment, name: string): string {
  const value = getInput(environment, name);
  if (!value) {
    throw new Error(`Missing required Action input: ${name}`);
  }
  return value;
}

function optionalInput(environment: Environment, name: string): string | undefined {
  return getInput(environment, name) || undefined;
}

function booleanInput(environment: Environment, name: string, fallback: boolean): boolean {
  const raw = getInput(environment, name);
  if (!raw) {
    return fallback;
  }

  const result = booleanSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid Action input: ${name} (expected true or false)`);
  }
  return result.data === 'true';
}

function integerInput(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = getInput(environment, name);
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Invalid Action input: ${name} (expected an integer from ${minimum} to ${maximum})`,
    );
  }
  return value;
}

function csvInput(environment: Environment, name: string): string[] {
  return [
    ...new Set(
      getInput(environment, name)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function previewHosts(environment: Environment): string[] {
  const hosts = csvInput(environment, 'preview-allowed-hosts');
  for (const host of hosts) {
    let parsed: URL;
    try {
      parsed = new URL(`https://${host}`);
    } catch {
      throw new Error('Invalid Action input: preview-allowed-hosts');
    }

    if (
      parsed.hostname !== host ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== '/'
    ) {
      throw new Error('Invalid Action input: preview-allowed-hosts');
    }
  }
  return hosts;
}

function enumInput<T extends z.ZodEnum>(
  environment: Environment,
  name: string,
  schema: T,
  fallback: z.infer<T>,
): z.infer<T> {
  const raw = getInput(environment, name);
  if (!raw) {
    return fallback;
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid Action input: ${name}`);
  }
  return result.data;
}

export function parseActionInputs(environment: Environment = process.env): ActionInputs {
  const labels = Object.fromEntries(
    lifecycleStates.map((state) => [
      state,
      getInput(environment, lifecycleLabelInputs[state]) || defaultLifecycleLabels[state],
    ]),
  ) as unknown as LifecycleLabels;
  if (new Set(Object.values(labels)).size !== lifecycleStates.length) {
    throw new Error('Action inputs contain duplicate lifecycle labels');
  }

  const anthropicApiKey = optionalInput(environment, 'anthropic-api-key');
  const cloudflareApiKey = optionalInput(environment, 'cloudflare-api-key');
  const cloudflareAccountId = optionalInput(environment, 'cloudflare-account-id');
  const openaiApiKey = optionalInput(environment, 'openai-api-key');
  if (cloudflareApiKey && !cloudflareAccountId) {
    throw new Error('Missing required Action input: cloudflare-account-id');
  }
  if (cloudflareAccountId && !cloudflareApiKey) {
    throw new Error('Missing required Action input: cloudflare-api-key');
  }
  if (!anthropicApiKey && !openaiApiKey && !(cloudflareApiKey && cloudflareAccountId)) {
    throw new Error('Missing required Action input: provider credentials');
  }

  const publicationTokenKind = enumInput(
    environment,
    'publication-token-kind',
    publicationTokenKindSchema,
    'github-token',
  );
  const allowDownstreamWorkflows = booleanInput(environment, 'allow-downstream-workflows', false);
  const safeDownstreamCi = booleanInput(environment, 'safe-downstream-ci', false);
  if (publicationTokenKind === 'workflow-triggering') {
    if (!allowDownstreamWorkflows || !safeDownstreamCi) {
      throw new Error('Invalid downstream workflow configuration');
    }
  } else if (allowDownstreamWorkflows || safeDownstreamCi) {
    throw new Error('Invalid downstream workflow configuration');
  }

  const extraBotLogins = csvInput(environment, 'bot-logins');
  const buildCommand = optionalInput(environment, 'build-command');
  const previewCommand = optionalInput(environment, 'preview-command');
  const prSkill = optionalInput(environment, 'pr-skill');

  return {
    activationPolicy: enumInput(
      environment,
      'activation-policy',
      activationPolicySchema,
      'automatic-public',
    ),
    allowDownstreamWorkflows,
    allowedPackageLabels: csvInput(environment, 'allowed-package-labels'),
    allowedPriorityLabels: csvInput(environment, 'allowed-priority-labels'),
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    autoPrOnFix: booleanInput(environment, 'auto-pr-on-fix', false),
    botLogins: [...new Set(['github-actions[bot]', ...extraBotLogins])],
    ...(buildCommand ? { buildCommand } : {}),
    ...(cloudflareAccountId ? { cloudflareAccountId } : {}),
    ...(cloudflareApiKey ? { cloudflareApiKey } : {}),
    labels,
    maxModelEvents: integerInput(environment, 'max-model-events', 4, 1, 20),
    ...(openaiApiKey ? { openaiApiKey } : {}),
    previewAllowedHosts: previewHosts(environment),
    ...(previewCommand ? { previewCommand } : {}),
    prFixVerifiedLabel: getInput(environment, 'pr-label-fix-verified') || 'fix verified',
    ...(prSkill ? { prSkill } : {}),
    prSkillName: getInput(environment, 'pr-skill-name') || 'pr-writer',
    publicationTokenKind,
    readToken: requiredInput(environment, 'read-token'),
    safeDownstreamCi,
    triageModel: getInput(environment, 'triage-model') || 'anthropic/claude-opus-4-6',
    triageSkill: requiredInput(environment, 'triage-skill'),
    verificationModel: getInput(environment, 'verification-model') || 'anthropic/claude-sonnet-4-6',
    writeToken: requiredInput(environment, 'write-token'),
  };
}
