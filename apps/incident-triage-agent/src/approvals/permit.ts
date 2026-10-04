import { randomUUID } from 'node:crypto';

import type { ApprovalPermit, PermitBinding } from '../domain/approval.js';

export function createPermit(input: {
  binding: PermitBinding;
  eligibleRoles: string[];
  expiresAt: Date;
  now?: Date;
}): ApprovalPermit {
  if (input.eligibleRoles.length === 0) throw new Error('PERMIT_ROLE_REQUIRED');
  const now = input.now ?? new Date();
  if (input.expiresAt <= now) throw new Error('PERMIT_EXPIRY_INVALID');
  return {
    id: randomUUID(),
    ...input.binding,
    eligibleRoles: [...new Set(input.eligibleRoles)].sort(),
    expiresAt: input.expiresAt,
    status: 'pending',
    createdAt: now,
  };
}
