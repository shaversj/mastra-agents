import type { ActionInputs } from './inputs.js';

export type ActionRoute = 'cleanup' | 'model' | 'noop';
export type RepositoryVisibility = 'internal' | 'private' | 'public' | 'unknown';

export interface PreflightContext {
  checkoutSafe?: boolean;
  prSkillPresent?: boolean;
  repositoryVisibility: RepositoryVisibility;
  route: ActionRoute;
  sandboxAvailable?: boolean;
  triageSkillPresent?: boolean;
}

export interface PreflightResult {
  activationPolicy: ActionInputs['activationPolicy'];
  maxModelEvents: number;
  publicationTokenKind: ActionInputs['publicationTokenKind'];
  route: ActionRoute;
}

export function preflightAction(inputs: ActionInputs, context: PreflightContext): PreflightResult {
  if (context.route === 'model') {
    if (context.repositoryVisibility !== 'public') {
      throw new Error('Model routes support public repositories only');
    }
    if (context.triageSkillPresent === false) {
      throw new Error('Configured triage skill is unavailable');
    }
    if (inputs.prSkill && context.prSkillPresent === false) {
      throw new Error('Configured PR skill is unavailable');
    }
    if (context.sandboxAvailable === false) {
      throw new Error('Required Linux sandbox is unavailable');
    }
    if (context.checkoutSafe === false) {
      throw new Error('Checkout credential hygiene validation failed');
    }
  }

  return {
    activationPolicy: inputs.activationPolicy,
    maxModelEvents: inputs.maxModelEvents,
    publicationTokenKind: inputs.publicationTokenKind,
    route: context.route,
  };
}
