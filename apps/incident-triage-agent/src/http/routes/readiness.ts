import { registerApiRoute, type ApiRoute } from '@mastra/core/server';
import type { Pool } from 'pg';

import { databaseIsReady } from '../../persistence/db.js';

export function createOperationalRoutes(pool: Pool): ApiRoute[] {
  return [
    registerApiRoute('/health', {
      method: 'GET',
      requiresAuth: false,
      handler: async (context) => context.json({ status: 'alive' }),
    }),
    registerApiRoute('/readyz', {
      method: 'GET',
      requiresAuth: false,
      handler: async (context) => {
        const ready = await databaseIsReady(pool);
        return context.json(
          ready ? { status: 'ready' } : { status: 'unavailable', reasonCode: 'DATABASE_NOT_READY' },
          ready ? 200 : 503,
        );
      },
    }),
  ];
}
