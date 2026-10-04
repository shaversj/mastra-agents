import { registerApiRoute, type ApiRoute } from '@mastra/core/server';
import { z } from 'zod';

import { currentBindingVersions } from '../../approvals/binding.js';
import type { AppConfig } from '../../config/app.js';
import type { PgApprovalRepository } from '../../persistence/repositories/approval-repository.js';
import type { AuthenticatedPrincipal } from '../../security/roles.js';
import { authorizeRoles } from '../middleware/authorize.js';

const decisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(1).max(2000),
});

export function createApprovalRoute(config: AppConfig, repository: PgApprovalRepository): ApiRoute {
  return registerApiRoute('/approvals/:permitId', {
    method: 'POST',
    middleware: authorizeRoles([config.approverRole]),
    handler: async (context) => {
      const parsed = decisionSchema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) return context.json({ reasonCode: 'INVALID_APPROVAL_DECISION' }, 400);
      const principal = context.get('requestContext').get('user') as AuthenticatedPrincipal;
      const permit = await repository.get(context.req.param('permitId'));
      if (!permit) return context.json({ reasonCode: 'PERMIT_NOT_FOUND' }, 404);
      const expectedBinding = await repository.getCurrentBinding(
        permit.id,
        currentBindingVersions(),
      );
      if (!expectedBinding) return context.json({ reasonCode: 'PERMIT_STALE' }, 409);
      try {
        await repository.consume({
          permitId: permit.id,
          actorId: principal.subject,
          actorRoles: principal.roles,
          decision: parsed.data.decision,
          reason: parsed.data.reason,
          expectedBinding,
        });
        return context.json({ status: 'resume_queued', permitId: permit.id }, 202);
      } catch (error) {
        const reasonCode = error instanceof Error ? error.message : 'PERMIT_CONFLICT';
        const allowed = new Set([
          'PERMIT_CONFLICT',
          'PERMIT_EXPIRED',
          'PERMIT_FORBIDDEN',
          'PERMIT_STALE',
        ]);
        const safeReason = allowed.has(reasonCode) ? reasonCode : 'PERMIT_CONFLICT';
        return context.json(
          { reasonCode: safeReason },
          safeReason === 'PERMIT_FORBIDDEN' ? 403 : 409,
        );
      }
    },
  });
}
