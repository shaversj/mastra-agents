import { registerApiRoute, type ApiRoute } from '@mastra/core/server';
import type { Pool } from 'pg';

import type { AppConfig } from '../../config/app.js';
import { authorizeRoles } from '../middleware/authorize.js';

export function createCaseRoutes(config: AppConfig, pool: Pool): ApiRoute[] {
  const operatorRoles = [config.operatorRole, config.approverRole, config.releaseReviewerRole];
  return [
    registerApiRoute('/cases/:caseId', {
      method: 'GET',
      middleware: authorizeRoles(operatorRoles),
      handler: async (context) => {
        const result = await pool.query<{
          id: string;
          source: string;
          source_incident_id: string;
          state: string;
          version: number;
          permit_id: string | null;
        }>(
          `SELECT c.id, c.source, c.source_incident_id, c.state, c.version,
                  p.id AS permit_id
           FROM incident_cases c
           LEFT JOIN LATERAL (
             SELECT id FROM incident_approval_permits
             WHERE case_id = c.id AND status = 'pending'
             ORDER BY created_at DESC LIMIT 1
           ) p ON true
           WHERE c.id = $1`,
          [context.req.param('caseId')],
        );
        const row = result.rows[0];
        if (!row) return context.json({ reasonCode: 'CASE_NOT_FOUND' }, 404);
        return context.json({
          id: row.id,
          source: row.source,
          sourceIncidentId: row.source_incident_id,
          state: row.state,
          version: row.version,
          ...(row.permit_id ? { pendingApproval: { permitId: row.permit_id } } : {}),
        });
      },
    }),
    registerApiRoute('/cases/:caseId/transitions', {
      method: 'GET',
      middleware: authorizeRoles(operatorRoles),
      handler: async (context) => {
        const result = await pool.query(
          `SELECT attempt_id AS "attemptId", from_state AS "fromState", to_state AS "toState",
                  case_version AS "caseVersion", reason_code AS "reasonCode", created_at AS "createdAt"
           FROM incident_case_transitions WHERE case_id = $1 ORDER BY case_version`,
          [context.req.param('caseId')],
        );
        return context.json({ transitions: result.rows });
      },
    }),
  ];
}
