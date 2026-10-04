export const appMetadata = {
  packageName: '@mastra-agents/incident-triage-agent',
  appId: 'incident-triage-agent',
  agentId: 'incident-triage-agent',
  workflowId: 'incident-triage-workflow',
} as const;

type Environment = Readonly<Record<string, string | undefined>>;

export interface AppConfig {
  modelId: string;
  databaseUrl: string;
  incidentHmacSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtJwksUrl: string;
  operatorRole: string;
  approverRole: string;
  releaseReviewerRole: string;
  processRole: 'api' | 'worker';
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
  evidenceRetentionDays: number;
  traceRetentionDays: number;
  governanceRetentionDays: number;
  approvalTtlSeconds: number;
  workerLeaseSeconds: number;
  modelTimeoutMs: number;
}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function boundedInteger(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid environment variable: ${name}`);
  }
  return value;
}

function httpUrl(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('HTTPS required');
    return url.toString();
  } catch {
    throw new Error(`Invalid environment variable: ${name}`);
  }
}

function databaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
      throw new Error('Postgres required');
    return value;
  } catch {
    throw new Error('Invalid environment variable: DATABASE_URL');
  }
}

function roleName(environment: Environment, name: string, fallback: string): string {
  const role = environment[name]?.trim() || fallback;
  if (!/^[a-z][a-z0-9:_-]{2,63}$/u.test(role)) {
    throw new Error(`Invalid environment variable: ${name}`);
  }
  return role;
}

export function loadAppConfig(environment: Environment = process.env): AppConfig {
  const secret = required(environment, 'INCIDENT_HMAC_SECRET');
  if (secret.length < 32) throw new Error('Invalid environment variable: INCIDENT_HMAC_SECRET');

  const processRole = environment.PROCESS_ROLE?.trim() || 'api';
  if (processRole !== 'api' && processRole !== 'worker') {
    throw new Error('Invalid environment variable: PROCESS_ROLE');
  }

  const host = environment.HOST?.trim() || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new Error('Invalid environment variable: HOST');
  }

  return {
    modelId: required(environment, 'MODEL_ID'),
    databaseUrl: databaseUrl(required(environment, 'DATABASE_URL')),
    incidentHmacSecret: secret,
    jwtIssuer: httpUrl(required(environment, 'JWT_ISSUER'), 'JWT_ISSUER'),
    jwtAudience: required(environment, 'JWT_AUDIENCE'),
    jwtJwksUrl: httpUrl(required(environment, 'JWT_JWKS_URL'), 'JWT_JWKS_URL'),
    operatorRole: roleName(environment, 'OPERATOR_ROLE', 'incident-operator'),
    approverRole: roleName(environment, 'APPROVER_ROLE', 'incident-approver'),
    releaseReviewerRole: roleName(environment, 'RELEASE_REVIEWER_ROLE', 'release-reviewer'),
    processRole,
    host,
    port: boundedInteger(environment, 'PORT', 4111, 1, 65_535),
    evidenceRetentionDays: boundedInteger(environment, 'EVIDENCE_RETENTION_DAYS', 30, 1, 365),
    traceRetentionDays: boundedInteger(environment, 'TRACE_RETENTION_DAYS', 7, 1, 90),
    governanceRetentionDays: boundedInteger(
      environment,
      'GOVERNANCE_RETENTION_DAYS',
      2555,
      365,
      3650,
    ),
    approvalTtlSeconds: boundedInteger(environment, 'APPROVAL_TTL_SECONDS', 3600, 60, 86_400),
    workerLeaseSeconds: boundedInteger(environment, 'WORKER_LEASE_SECONDS', 60, 10, 600),
    modelTimeoutMs: boundedInteger(environment, 'MODEL_TIMEOUT_MS', 30_000, 1000, 600_000),
  };
}
