export interface AuthenticatedPrincipal {
  subject: string;
  roles: string[];
}

export function hasRole(principal: AuthenticatedPrincipal, role: string): boolean {
  return principal.roles.includes(role);
}

export function hasAnyRole(principal: AuthenticatedPrincipal, roles: readonly string[]): boolean {
  return roles.some((role) => hasRole(principal, role));
}
