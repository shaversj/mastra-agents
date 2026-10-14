import { describe, expect, it, vi } from 'vitest';

import { parsePreviewInspectionOutput, runPreview } from '../src/preview/run-preview.js';

const metadata = {
  branch: 'triagebot/fix-42',
  repository: 'owner/repo',
  sha: 'b'.repeat(40),
};
const publication = { branch: metadata.branch, confirmed: true as const, headSha: metadata.sha };

describe('preview boundary', () => {
  it('accepts only bounded strict inspection JSON without reflecting output', () => {
    expect(parsePreviewInspectionOutput('{"artifactId":"artifact-1"}')).toEqual({
      artifactId: 'artifact-1',
    });
    expect(() => parsePreviewInspectionOutput('{"artifactId":"ok","secret":"CANARY"}')).toThrow(
      'PREVIEW_INSPECTION_INVALID',
    );
    expect(() => parsePreviewInspectionOutput('not-json CANARY')).toThrow(
      'PREVIEW_INSPECTION_INVALID',
    );
    expect(() => parsePreviewInspectionOutput('x'.repeat(8_193))).toThrow(
      'PREVIEW_INSPECTION_INVALID',
    );
  });
  it('treats absent configuration and launcher failure as nonfatal', async () => {
    await expect(runPreview({ allowedHosts: [], metadata })).resolves.toEqual({
      status: 'skipped',
      urls: [],
    });
    await expect(
      runPreview({
        allowedHosts: ['preview.example.com'],
        inspectChangedCode: async () => ({ artifactId: 'artifact-1' }),
        launch: async () => {
          throw new Error('secret launcher output');
        },
        lease: { assertCurrent: async () => undefined },
        metadata,
        previewCredentials: { PREVIEW_TOKEN: 'preview-only' },
        publication,
        workspaceRoot: '/untrusted/checkout',
      }),
    ).resolves.toEqual({ reasonCode: 'PREVIEW_LAUNCH_FAILED', status: 'failed', urls: [] });
  });

  it('separates offline changed-code inspection from a metadata-only network launcher', async () => {
    const inspectChangedCode = vi.fn(async () => ({ artifactId: 'artifact-1' }));
    const launch = vi.fn(async (input: unknown) => {
      void input;
      return {
        status: 'ready',
        urls: ['https://preview.example.com/build/42'],
      };
    });
    const lease = { assertCurrent: vi.fn(async () => undefined) };

    const result = await runPreview({
      allowedHosts: ['preview.example.com'],
      inspectChangedCode,
      launch,
      lease,
      metadata,
      previewCredentials: { PREVIEW_TOKEN: 'preview-only' },
      publication,
      workspaceRoot: '/untrusted/checkout',
    });

    expect(result).toEqual({
      status: 'ready',
      urls: ['https://preview.example.com/build/42'],
    });
    expect(inspectChangedCode).toHaveBeenCalledWith({
      environment: {},
      network: false,
      workspaceRoot: '/untrusted/checkout',
    });
    expect(lease.assertCurrent).toHaveBeenCalledOnce();
    expect(lease.assertCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      launch.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(launch).toHaveBeenCalledWith({
      artifactId: 'artifact-1',
      credentials: { PREVIEW_TOKEN: 'preview-only' },
      metadata,
    });
    expect(launch.mock.calls[0]?.[0]).not.toHaveProperty('workspaceRoot');
  });

  it('runs inspection without a launcher and returns a bounded nonfatal failure', async () => {
    const inspectChangedCode = vi.fn(async (context) => {
      expect(context).toEqual({
        environment: {},
        network: false,
        workspaceRoot: '/isolated/workspace',
      });
      expect(JSON.stringify(context)).not.toContain('PROVIDER_CANARY');
      return { artifactId: 'artifact-1' };
    });

    await expect(
      runPreview({
        allowedHosts: [],
        inspectChangedCode,
        lease: { assertCurrent: async () => undefined },
        metadata,
        publication,
        workspaceRoot: '/isolated/workspace',
      }),
    ).resolves.toEqual({
      reasonCode: 'PREVIEW_CONFIGURATION_INVALID',
      status: 'failed',
      urls: [],
    });
    expect(inspectChangedCode).toHaveBeenCalledOnce();
  });

  it.each([
    [{ status: 'ready', urls: ['http://preview.example.com/build'] }, 'PREVIEW_RESULT_INVALID'],
    [{ status: 'ready', urls: ['https://evil.example/build'] }, 'PREVIEW_HOST_DENIED'],
    [
      { status: 'ready', urls: ['https://user:pass@preview.example.com/build'] },
      'PREVIEW_RESULT_INVALID',
    ],
    [
      {
        status: 'ready',
        urls: Array.from({ length: 6 }, (_, i) => `https://preview.example.com/${i}`),
      },
      'PREVIEW_RESULT_INVALID',
    ],
  ])('rejects unsafe launcher result %#', async (response, reasonCode) => {
    await expect(
      runPreview({
        allowedHosts: ['preview.example.com'],
        inspectChangedCode: async () => ({ artifactId: 'artifact' }),
        launch: async () => response,
        lease: { assertCurrent: async () => undefined },
        metadata,
        previewCredentials: {},
        publication,
        workspaceRoot: '/checkout',
      }),
    ).resolves.toEqual({ reasonCode, status: 'failed', urls: [] });
  });

  it('does not launch after lease loss', async () => {
    const launch = vi.fn();
    await expect(
      runPreview({
        allowedHosts: ['preview.example.com'],
        inspectChangedCode: async () => ({ artifactId: 'artifact' }),
        launch,
        lease: { assertCurrent: async () => Promise.reject(new Error('LEASE_LOST')) },
        metadata,
        previewCredentials: {},
        publication,
        workspaceRoot: '/checkout',
      }),
    ).rejects.toThrow('LEASE_LOST');
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not inspect or launch without exact branch publication proof', async () => {
    const inspectChangedCode = vi.fn();
    const launch = vi.fn();
    await expect(
      runPreview({
        allowedHosts: ['preview.example.com'],
        inspectChangedCode,
        launch,
        lease: { assertCurrent: async () => undefined },
        metadata,
        previewCredentials: {},
        publication: { ...publication, headSha: 'c'.repeat(40) },
        workspaceRoot: '/checkout',
      }),
    ).resolves.toEqual({
      reasonCode: 'PREVIEW_PUBLICATION_UNCONFIRMED',
      status: 'failed',
      urls: [],
    });
    expect(inspectChangedCode).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('requires a lease and rejects preview credentials reflected in a result URL', async () => {
    const configured = {
      allowedHosts: ['preview.example.com'],
      inspectChangedCode: async () => ({ artifactId: 'artifact' }),
      launch: async () => ({
        status: 'ready' as const,
        urls: ['https://preview.example.com/build?token=preview-only'],
      }),
      metadata,
      previewCredentials: { PREVIEW_TOKEN: 'preview-only' },
      publication,
      workspaceRoot: '/checkout',
    };
    await expect(runPreview(configured)).resolves.toEqual({
      reasonCode: 'PREVIEW_CONFIGURATION_INVALID',
      status: 'failed',
      urls: [],
    });
    await expect(
      runPreview({ ...configured, lease: { assertCurrent: async () => undefined } }),
    ).resolves.toEqual({
      reasonCode: 'PREVIEW_RESULT_INVALID',
      status: 'failed',
      urls: [],
    });
  });
});
