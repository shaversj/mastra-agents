export interface PermitBinding {
  caseId: string;
  caseVersion: number;
  attemptId: string;
  mastraRunId: string;
  suspendedStep: string;
  manifestDigest: string;
  decisionDigest: string;
  stagedParametersDigest: string;
  verificationPlanDigest: string;
  buildVersion: string;
  promptVersion: string;
  schemaVersion: string;
  policyVersion: string;
  catalogVersion: string;
  collectorVersion: string;
  redactionVersion: string;
}

export interface ApprovalPermit extends PermitBinding {
  id: string;
  eligibleRoles: string[];
  expiresAt: Date;
  status: 'pending' | 'consumed' | 'expired' | 'superseded';
  createdAt: Date;
  consumedAt?: Date;
  consumedCaseVersion?: number;
  actorId?: string;
  actorRole?: string;
  decision?: 'approved' | 'rejected';
  reason?: string;
}

export interface ApprovalDecisionInput {
  permitId: string;
  actorId: string;
  actorRoles: string[];
  decision: 'approved' | 'rejected';
  reason: string;
  expectedBinding: PermitBinding;
  now?: Date;
}
