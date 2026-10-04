import type { PermitBinding } from '../domain/approval.js';
import { canonicalize, sha256 } from '../evidence/canonicalize.js';

export function bindingDigest(binding: PermitBinding): string {
  return sha256(
    canonicalize({
      attemptId: binding.attemptId,
      buildVersion: binding.buildVersion,
      caseId: binding.caseId,
      caseVersion: binding.caseVersion,
      catalogVersion: binding.catalogVersion,
      collectorVersion: binding.collectorVersion,
      decisionDigest: binding.decisionDigest,
      manifestDigest: binding.manifestDigest,
      mastraRunId: binding.mastraRunId,
      policyVersion: binding.policyVersion,
      promptVersion: binding.promptVersion,
      redactionVersion: binding.redactionVersion,
      schemaVersion: binding.schemaVersion,
      stagedParametersDigest: binding.stagedParametersDigest,
      suspendedStep: binding.suspendedStep,
      verificationPlanDigest: binding.verificationPlanDigest,
    }),
  );
}

export function assertPermitBinding(actual: PermitBinding, expected: PermitBinding): void {
  if (bindingDigest(actual) !== bindingDigest(expected)) throw new Error('PERMIT_STALE');
}
