import type { AttemptRecord } from '../domain/case.js';

export async function reconcileAttempt(options: {
  attempt: AttemptRecord;
  getWorkflowRun(runId: string): Promise<unknown | null>;
}): Promise<'not_dispatched' | 'known_run' | 'missing_run'> {
  if (!options.attempt.mastraRunId) return 'not_dispatched';
  return (await options.getWorkflowRun(options.attempt.mastraRunId)) ? 'known_run' : 'missing_run';
}
