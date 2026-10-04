import type { TriageDecision } from '../domain/decision.js';

export interface MitigationCatalogEntry {
  action: TriageDecision['nextAction'];
  posture: 'advisory' | 'approval_required' | 'human_input';
  simulationOnly: true;
}

export const mitigationCatalog: Readonly<
  Record<TriageDecision['nextAction'], MitigationCatalogEntry>
> = {
  escalate_owner: { action: 'escalate_owner', posture: 'advisory', simulationOnly: true },
  rollback_release: {
    action: 'rollback_release',
    posture: 'approval_required',
    simulationOnly: true,
  },
  scale_service: { action: 'scale_service', posture: 'approval_required', simulationOnly: true },
  continue_monitoring: {
    action: 'continue_monitoring',
    posture: 'advisory',
    simulationOnly: true,
  },
  request_human_input: {
    action: 'request_human_input',
    posture: 'human_input',
    simulationOnly: true,
  },
};
