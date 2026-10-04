import { registerApiRoute, type ApiRoute } from '@mastra/core/server';
import { z } from 'zod';

import type { AppConfig } from '../../config/app.js';
import type { PgCaseRepository } from '../../persistence/repositories/case-repository.js';
import { createHmacMiddleware } from '../middleware/hmac.js';

const intakeSchema = z.object({
  source: z.string().min(1).max(64),
  deliveryId: z.string().min(1).max(256),
  sourceIncidentId: z.string().min(1).max(256),
  redactedPayload: z.record(z.string(), z.unknown()),
});

export function createIntakeRoute(config: AppConfig, repository: PgCaseRepository): ApiRoute {
  return registerApiRoute('/incidents', {
    method: 'POST',
    requiresAuth: false,
    middleware: createHmacMiddleware(config.incidentHmacSecret),
    handler: async (context) => {
      const parsed = intakeSchema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) return context.json({ reasonCode: 'INVALID_INCIDENT' }, 400);
      const accepted = await repository.acceptDelivery(parsed.data);
      return context.json(
        {
          caseId: accepted.caseId,
          attemptId: accepted.attemptId,
          duplicate: accepted.duplicate,
          statusUrl: `/cases/${accepted.caseId}`,
        },
        202,
      );
    },
  });
}
