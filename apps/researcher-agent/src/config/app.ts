export const appMetadata = {
  packageName: '@mastra-agents/researcher-agent',
  appId: 'researcher-agent',
  agentId: 'researcher-agent',
} as const;

type Environment = Readonly<Record<string, string | undefined>>;

export interface AppConfig {
  modelId: string;
  host: '127.0.0.1';
  port: number;
}

export function loadAppConfig(environment: Environment = process.env): AppConfig {
  const modelId = environment.MODEL_ID?.trim();

  if (!modelId) {
    throw new Error('Missing required environment variable: MODEL_ID');
  }

  const host = environment.HOST?.trim() || '127.0.0.1';
  if (host !== '127.0.0.1') {
    throw new Error('Invalid environment variable: HOST (expected 127.0.0.1)');
  }

  const portValue = environment.PORT?.trim() || '4111';
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Invalid environment variable: PORT (expected an integer from 1 to 65535)');
  }

  return { modelId, host, port };
}
