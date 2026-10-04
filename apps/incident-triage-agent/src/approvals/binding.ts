import type { PermitBinding } from '../domain/approval.js';

export type BindingVersions = Pick<
  PermitBinding,
  | 'buildVersion'
  | 'promptVersion'
  | 'schemaVersion'
  | 'policyVersion'
  | 'catalogVersion'
  | 'collectorVersion'
  | 'redactionVersion'
>;

export function currentBindingVersions(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BindingVersions {
  return {
    buildVersion: environment.APP_BUILD_VERSION?.trim() || 'development',
    promptVersion: 'incident-triage-prompt/v1',
    schemaVersion: 'incident-decision/v1',
    policyVersion: 'mitigation-policy/v1',
    catalogVersion: 'mitigation-catalog/v1',
    collectorVersion: 'collector/v1',
    redactionVersion: 'redaction/v1',
  };
}
