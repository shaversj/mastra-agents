export const caseStates = [
  'queued',
  'collecting_evidence',
  'decision_pending',
  'decision_validated',
  'approval_pending',
  'resume_queued',
  'simulation_recorded',
  'human_input_needed',
  'retry_wait',
  'recoverable_failure',
  'completed',
] as const;

export type CaseState = (typeof caseStates)[number];
export type FailureClassification = 'retryable' | 'reviewable_terminal' | 'invalid_input';

export interface CaseRecord {
  id: string;
  source: string;
  sourceIncidentId: string;
  state: CaseState;
  version: number;
}

export interface AttemptRecord {
  id: string;
  caseId: string;
  deliveryId: string;
  state: CaseState;
  mastraRunId?: string;
}

export interface CaseTransition {
  id: string;
  caseId: string;
  attemptId: string;
  fromState: CaseState | null;
  toState: CaseState;
  caseVersion: number;
  reasonCode: string;
  createdAt: Date;
}

export function assertReasonCode(reasonCode: string): void {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/u.test(reasonCode)) throw new Error('INVALID_REASON_CODE');
}
