import { z } from 'zod';

import type { LeaseGuard } from '../github/lease.js';

export interface PreviewMetadata {
  branch: string;
  repository: string;
  sha: string;
}

export type PreviewFailureCode =
  | 'PREVIEW_CONFIGURATION_INVALID'
  | 'PREVIEW_HOST_DENIED'
  | 'PREVIEW_INSPECTION_FAILED'
  | 'PREVIEW_INSPECTION_INVALID'
  | 'PREVIEW_LAUNCH_FAILED'
  | 'PREVIEW_PUBLICATION_UNCONFIRMED'
  | 'PREVIEW_RESULT_INVALID';

export type PreviewResult =
  | { status: 'ready'; urls: readonly string[] }
  | { reasonCode: PreviewFailureCode; status: 'failed'; urls: readonly [] }
  | { status: 'skipped'; urls: readonly [] };

const launcherResultSchema = z
  .object({
    status: z.literal('ready'),
    urls: z.array(z.string().min(1).max(2_048)).min(1).max(5),
  })
  .strict();
const inspectionResultSchema = z.object({ artifactId: z.string().min(1).max(200) }).strict();
const launcherRequestSchema = z
  .object({
    artifactId: z.string().min(1).max(200),
    metadata: z
      .object({
        branch: z.string().min(1).max(255),
        repository: z
          .string()
          .min(3)
          .max(200)
          .regex(/^[^/\s]+\/[^/\s]+$/u),
        sha: z.string().regex(/^[0-9a-f]{40}$/u),
      })
      .strict(),
  })
  .strict();
const maximumLauncherResponseBytes = 8_192;

async function readBoundedResponseBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maximumLauncherResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('PREVIEW_RESULT_INVALID');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export function parsePreviewInspectionOutput(output: string): { artifactId: string } {
  if (Buffer.byteLength(output) > 8_192) throw new Error('PREVIEW_INSPECTION_INVALID');
  try {
    return inspectionResultSchema.parse(JSON.parse(output) as unknown);
  } catch {
    throw new Error('PREVIEW_INSPECTION_INVALID');
  }
}

function validateCredentials(credentials: Readonly<Record<string, string>>): void {
  const entries = Object.entries(credentials);
  if (entries.length > 10) throw new Error('PREVIEW_CREDENTIALS_INVALID');
  for (const [name, value] of entries) {
    if (
      !/^PREVIEW_[A-Z0-9_]{1,80}$/u.test(name) ||
      !value ||
      value.length > 4_096 ||
      /GITHUB|OPENAI|ANTHROPIC|CLOUDFLARE/iu.test(name)
    ) {
      throw new Error('PREVIEW_CREDENTIALS_INVALID');
    }
  }
}

export function createHttpPreviewLauncher(input: {
  allowedHosts: readonly string[];
  endpoint: string;
  fetch?: typeof fetch;
}): NonNullable<Parameters<typeof runPreview>[0]['launch']> {
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new Error('PREVIEW_CONFIGURATION_INVALID');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.hash ||
    !input.allowedHosts.includes(endpoint.hostname)
  ) {
    throw new Error('PREVIEW_CONFIGURATION_INVALID');
  }
  const request = input.fetch ?? fetch;
  return async ({ artifactId, credentials, metadata }) => {
    if (
      Object.keys(credentials).length !== 1 ||
      !credentials.PREVIEW_TOKEN ||
      /[\r\n\0]/u.test(credentials.PREVIEW_TOKEN)
    ) {
      throw new Error('PREVIEW_CREDENTIALS_INVALID');
    }
    const payload = launcherRequestSchema.safeParse({ artifactId, metadata });
    if (!payload.success) throw new Error('PREVIEW_CONFIGURATION_INVALID');
    const response = await request(endpoint, {
      body: JSON.stringify(payload.data),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credentials.PREVIEW_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'mastra-triage-agent-preview',
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('PREVIEW_LAUNCH_FAILED');
    if (!/^application\/json(?:;|$)/iu.test(response.headers.get('content-type') ?? '')) {
      throw new Error('PREVIEW_RESULT_INVALID');
    }
    const advertisedBytes = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertisedBytes) && advertisedBytes > maximumLauncherResponseBytes) {
      throw new Error('PREVIEW_RESULT_INVALID');
    }
    const text = await readBoundedResponseBody(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('PREVIEW_RESULT_INVALID');
    }
  };
}

export async function runPreview(input: {
  allowedHosts: readonly string[];
  inspectChangedCode?: (context: {
    environment: Record<string, never>;
    network: false;
    workspaceRoot: string;
  }) => Promise<{ artifactId: string }>;
  launch?: (input: {
    artifactId: string;
    credentials: Readonly<Record<string, string>>;
    metadata: PreviewMetadata;
  }) => Promise<unknown>;
  lease?: LeaseGuard;
  metadata: PreviewMetadata;
  previewCredentials?: Readonly<Record<string, string>>;
  publication?: { branch: string; confirmed: true; headSha: string };
  workspaceRoot?: string;
}): Promise<PreviewResult> {
  if (!input.inspectChangedCode && !input.launch && !input.workspaceRoot) {
    return { status: 'skipped', urls: [] };
  }
  if (!input.inspectChangedCode || !input.lease || !input.workspaceRoot) {
    return { reasonCode: 'PREVIEW_CONFIGURATION_INVALID', status: 'failed', urls: [] };
  }
  if (
    !input.publication?.confirmed ||
    input.publication.branch !== input.metadata.branch ||
    input.publication.headSha !== input.metadata.sha
  ) {
    return { reasonCode: 'PREVIEW_PUBLICATION_UNCONFIRMED', status: 'failed', urls: [] };
  }

  const credentials = input.previewCredentials ?? {};
  validateCredentials(credentials);
  let artifact: { artifactId: string };
  try {
    artifact = await input.inspectChangedCode({
      environment: {},
      network: false,
      workspaceRoot: input.workspaceRoot,
    });
    if (!artifact.artifactId || artifact.artifactId.length > 200) {
      return { reasonCode: 'PREVIEW_INSPECTION_INVALID', status: 'failed', urls: [] };
    }
  } catch {
    return { reasonCode: 'PREVIEW_INSPECTION_FAILED', status: 'failed', urls: [] };
  }

  if (!input.launch) {
    return { reasonCode: 'PREVIEW_CONFIGURATION_INVALID', status: 'failed', urls: [] };
  }

  await input.lease.assertCurrent();
  let raw: unknown;
  try {
    raw = await input.launch({
      artifactId: artifact.artifactId,
      credentials,
      metadata: input.metadata,
    });
  } catch {
    return { reasonCode: 'PREVIEW_LAUNCH_FAILED', status: 'failed', urls: [] };
  }
  const parsed = launcherResultSchema.safeParse(raw);
  if (!parsed.success) {
    return { reasonCode: 'PREVIEW_RESULT_INVALID', status: 'failed', urls: [] };
  }
  for (const value of parsed.data.urls) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { reasonCode: 'PREVIEW_RESULT_INVALID', status: 'failed', urls: [] };
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
      return { reasonCode: 'PREVIEW_RESULT_INVALID', status: 'failed', urls: [] };
    }
    if (!input.allowedHosts.includes(url.hostname)) {
      return { reasonCode: 'PREVIEW_HOST_DENIED', status: 'failed', urls: [] };
    }
    if (Object.values(credentials).some((credential) => value.includes(credential))) {
      return { reasonCode: 'PREVIEW_RESULT_INVALID', status: 'failed', urls: [] };
    }
  }
  return parsed.data;
}
