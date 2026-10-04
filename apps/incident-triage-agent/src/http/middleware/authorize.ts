import type { MiddlewareHandler } from '@mastra/core/server';

import type { AuthenticatedPrincipal } from '../../security/roles.js';
import { hasAnyRole } from '../../security/roles.js';

export function isAuthorized(
  principal: AuthenticatedPrincipal | undefined,
  roles: readonly string[],
): boolean {
  return Boolean(principal && hasAnyRole(principal, roles));
}

export function authorizeRoles(roles: readonly string[]): MiddlewareHandler {
  return async (context, next) => {
    const principal = context.get('requestContext').get('user') as
      AuthenticatedPrincipal | undefined;
    if (!isAuthorized(principal, roles)) {
      return context.json({ reasonCode: 'FORBIDDEN' }, 403);
    }
    return next();
  };
}
