import type { ActionInputs, ModelActionInputs } from './inputs.js';

export type ActionRoute = 'cleanup' | 'conflict' | 'model' | 'noop';
export type RepositoryVisibility = 'internal' | 'private' | 'public' | 'unknown';

export interface PreflightContext {
  branchProvenanceVerified?: boolean;
  checkoutSafe?: boolean;
  githubIdentityVerified?: boolean;
  labelsPresent?: boolean;
  prSkillPresent?: boolean;
  prSkillRequired?: boolean;
  repositoryVisibility: RepositoryVisibility;
  route: ActionRoute;
  sandboxAvailable?: boolean;
  triageSkillPresent?: boolean;
}

function assertModelCredentials(model: string, inputs: ActionInputs): void {
  if (model.startsWith('anthropic/')) {
    if (!inputs.anthropicApiKey) {
      throw new Error('Missing Anthropic credentials for configured model');
    }
    return;
  }
  if (model.startsWith('openai/')) {
    if (!inputs.openaiApiKey) {
      throw new Error('Missing OpenAI credentials for configured model');
    }
    return;
  }
  if (model.startsWith('cloudflare-workers-ai/')) {
    if (!inputs.cloudflareApiKey || !inputs.cloudflareAccountId) {
      throw new Error('Missing Cloudflare Workers AI credentials for configured model');
    }
    return;
  }
  throw new Error('Unsupported configured model provider');
}

export function preflightRoute(context: PreflightContext): void {
  if (context.route === 'noop') return;
  if (context.route === 'cleanup') {
    if (context.githubIdentityVerified !== true) {
      throw new Error('GitHub Action identity validation failed');
    }
    if (context.branchProvenanceVerified !== true) {
      throw new Error('Proposal branch provenance validation failed');
    }
    return;
  }
  if (context.route === 'conflict') {
    if (context.githubIdentityVerified !== true) {
      throw new Error('GitHub Action identity validation failed');
    }
    return;
  }
  if (context.repositoryVisibility !== 'public') {
    throw new Error('Model routes support public repositories only');
  }
}

export function preflightAction(
  inputs: ActionInputs,
  context: PreflightContext,
): asserts inputs is ModelActionInputs {
  preflightRoute(context);
  if (context.route === 'model') {
    if (context.labelsPresent !== true) {
      throw new Error('Configured repository labels are unavailable');
    }
    assertModelCredentials(inputs.triageModel, inputs);
    assertModelCredentials(inputs.verificationModel, inputs);
    if (!inputs.triageSkill) throw new Error('Missing required Action input: triage-skill');
    if (context.triageSkillPresent === false) {
      throw new Error('Configured triage skill is unavailable');
    }
    if (inputs.prSkill && context.prSkillRequired && context.prSkillPresent === false) {
      throw new Error('Configured PR skill is unavailable');
    }
    if (context.sandboxAvailable === false) {
      throw new Error('Required Linux sandbox is unavailable');
    }
    if (context.checkoutSafe === false) {
      throw new Error('Checkout credential hygiene validation failed');
    }
  }
}
