import type { TriageDecision } from '../domain/decision.js';
import { mitigationCatalog } from './catalog.js';

export interface PolicyResult {
  disposition: 'completed' | 'approval_pending' | 'human_input_needed';
  requiresApproval: boolean;
  executed: false;
  catalogAction: TriageDecision['nextAction'];
}

export function applyMitigationPolicy(decision: TriageDecision): PolicyResult {
  const entry = mitigationCatalog[decision.nextAction];
  if (entry.posture === 'approval_required') {
    return {
      disposition: 'approval_pending',
      requiresApproval: true,
      executed: false,
      catalogAction: entry.action,
    };
  }
  if (entry.posture === 'human_input') {
    return {
      disposition: 'human_input_needed',
      requiresApproval: false,
      executed: false,
      catalogAction: entry.action,
    };
  }
  return {
    disposition: 'completed',
    requiresApproval: false,
    executed: false,
    catalogAction: entry.action,
  };
}
