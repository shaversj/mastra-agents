import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { appMetadata } from '../../config/app.js';

const shellSchema = z.object({ attemptId: z.string().min(1) });

const shellStep = createStep({
  id: 'accept-attempt',
  inputSchema: shellSchema,
  outputSchema: shellSchema,
  execute: async ({ inputData }) => inputData,
});

export const incidentTriageWorkflow = createWorkflow({
  id: appMetadata.workflowId,
  description: 'Runs the bounded incident triage lifecycle for one durable workflow attempt.',
  inputSchema: shellSchema,
  outputSchema: shellSchema,
})
  .then(shellStep)
  .commit();
