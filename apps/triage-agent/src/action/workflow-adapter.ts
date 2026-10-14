import type { ActionInputs } from './inputs.js';
import { appMetadata } from '../config/app.js';
import type { ProjectedGitHubEvent } from '../domain/event-projection.js';
import { triageWorkflowOutputSchema } from '../mastra/workflows/triage.js';

export async function runRegisteredWorkflow(
  mastra: unknown,
  workflowId: string,
  inputData: unknown,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  const registry = mastra as {
    getWorkflow(id: string): {
      createRun(): Promise<{
        cancel(): Promise<void>;
        start(input: {
          inputData: unknown;
          tracingOptions: { hideInput: true; hideOutput: true };
        }): Promise<
          { result: unknown; status: 'success' } | { status: Exclude<string, 'success'> }
        >;
      }>;
    };
  };
  abortSignal?.throwIfAborted();
  const run = await registry.getWorkflow(workflowId).createRun();
  abortSignal?.throwIfAborted();
  let removeAbortListener: () => void = () => undefined;
  const abortPromise = abortSignal
    ? new Promise<never>((_resolve, reject) => {
        let cancellationStarted = false;
        const cancel = () => {
          if (cancellationStarted) return;
          cancellationStarted = true;
          void run
            .cancel()
            .catch(() => undefined)
            .then(() => {
              reject(
                abortSignal.reason instanceof Error
                  ? abortSignal.reason
                  : new Error('ACTION_ABORTED'),
              );
            });
        };
        abortSignal.addEventListener('abort', cancel, { once: true });
        removeAbortListener = () => abortSignal.removeEventListener('abort', cancel);
        if (abortSignal.aborted) cancel();
      })
    : undefined;
  let result: { result: unknown; status: 'success' } | { status: Exclude<string, 'success'> };
  try {
    const started = run.start({
      inputData,
      tracingOptions: { hideInput: true, hideOutput: true },
    });
    result = abortPromise ? await Promise.race([started, abortPromise]) : await started;
  } finally {
    removeAbortListener();
  }
  if (result.status !== 'success' || !('result' in result)) {
    throw new Error('MASTRA_WORKFLOW_FAILED');
  }
  return result.result;
}

export async function runTriageWorkflow(input: {
  abortSignal?: AbortSignal;
  baseSha: string | undefined;
  event: ProjectedGitHubEvent;
  generation: number;
  inputs: ActionInputs;
  mastra: unknown;
  runWorkflow?: typeof runRegisteredWorkflow;
  triggeringComment?: { body: string; id: number };
}): Promise<ReturnType<typeof triageWorkflowOutputSchema.parse>> {
  return triageWorkflowOutputSchema.parse(
    await (input.runWorkflow ?? runRegisteredWorkflow)(
      input.mastra,
      appMetadata.workflowIds.triage,
      {
        allowedPackageLabels: input.inputs.allowedPackageLabels,
        allowedPriorityLabels: input.inputs.allowedPriorityLabels,
        attemptId: input.event.eventFingerprint,
        autoPrOnFix: input.inputs.autoPrOnFix,
        eventFingerprint: input.event.eventFingerprint,
        generation: input.generation,
        issue: {
          body: input.event.issue.body,
          number: input.event.issue.number,
          reporterLogin: input.event.issue.reporterLogin,
          title: input.event.issue.title,
        },
        repository: {
          baseSha: input.baseSha,
          defaultBranch: input.event.repository.defaultBranch,
          fullName: input.event.repository.fullName,
        },
        ...(input.triggeringComment ? { triggeringComment: input.triggeringComment } : {}),
      },
      input.abortSignal,
    ),
  );
}
