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
  if (!input.inspectChangedCode || !input.launch || !input.lease || !input.workspaceRoot) {
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
