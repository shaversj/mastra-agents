import { MastraAuthProvider } from '@mastra/core/server';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';

import type { AppConfig } from '../config/app.js';
import type { AuthenticatedPrincipal } from './roles.js';

function readRoles(payload: JWTPayload): string[] | null {
  if (!Array.isArray(payload.roles)) return null;
  const roles = payload.roles.filter(
    (role): role is string => typeof role === 'string' && role.length > 0,
  );
  return roles.length === payload.roles.length && roles.length > 0 ? [...new Set(roles)] : null;
}

class JwtAuthProvider extends MastraAuthProvider<AuthenticatedPrincipal> {
  constructor(
    private readonly config: AppConfig,
    private readonly keyResolver: JWTVerifyGetKey,
  ) {
    super({ name: 'incident-jwt' });
  }

  async authenticateToken(token: string): Promise<AuthenticatedPrincipal | null> {
    try {
      const { payload } = await jwtVerify(token.replace(/^Bearer\s+/iu, ''), this.keyResolver, {
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
        algorithms: ['RS256', 'ES256'],
      });
      const roles = readRoles(payload);
      if (!payload.sub || !roles) return null;
      return { subject: payload.sub, roles };
    } catch {
      return null;
    }
  }

  authorizeUser(_user: AuthenticatedPrincipal, request: Request | { raw?: Request }): boolean {
    const raw = request instanceof Request ? request : request.raw;
    if (!raw) return false;
    const path = new URL(raw.url).pathname;
    return !/^\/api\/workflows\/[^/]+\/resume(?:-|\/|$)/u.test(path);
  }

  override mapUserToResourceId(user: AuthenticatedPrincipal): string {
    return user.subject;
  }
}

export function createJwtAuthProvider(
  config: AppConfig,
  keyResolver: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.jwtJwksUrl)),
): MastraAuthProvider<AuthenticatedPrincipal> {
  return new JwtAuthProvider(config, keyResolver);
}
