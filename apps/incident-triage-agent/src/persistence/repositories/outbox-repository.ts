export type OutboxStatus = 'pending' | 'leased' | 'completed' | 'failed';

export interface OutboxRecord {
  id: string;
  kind: 'start_workflow' | 'resume_workflow';
  attemptId: string;
  status: OutboxStatus;
  dispatchAttempts: number;
  nextAttemptAt: Date;
  leaseOwner?: string;
  leaseGeneration: number;
  leaseExpiresAt?: Date;
  reasonCode?: string;
}

export interface OutboxLease extends OutboxRecord {
  owner: string;
  generation: number;
}
