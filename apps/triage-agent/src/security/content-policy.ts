import { assertCredentialFreeContent } from './diff-policy.js';

const markdownLinkPattern = /!?(?:\[[^\]]*\])\(([^)]+)\)/gu;
const rawUrlPattern = /https?:\/\/[^\s)>]+/gu;
const activeHtmlPattern = /<\/?[A-Za-z][^>]*>/u;
const massMentionPattern = /@(everyone|here|all)\b/iu;
const teamMentionPattern = /@[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9-]*/u;
const automationCommandPattern = /(^|\n)\s*\/(?:approve|deploy|merge|rebuild|retest|run|test)\b/iu;
const commandOrSourcePattern =
  /[`{};]|(?:^|\s)(?:bash|bun|curl|git|npm|pnpm|powershell|sh|sudo|wget|yarn)\s/iu;

export interface TriageReportSemantics {
  details: readonly string[];
  headline: string;
}

function assertAllowedUrl(value: string, allowedHosts: readonly string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('OUTBOUND_URL_INVALID');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !allowedHosts.includes(parsed.hostname)
  ) {
    throw new Error('OUTBOUND_URL_DENIED');
  }
}

export function assertSafeOutboundText(
  value: string,
  options: { allowedHosts?: readonly string[]; maxCharacters?: number } = {},
): void {
  if (!value || value.length > (options.maxCharacters ?? 8_000) || value.includes('\0')) {
    throw new Error('OUTBOUND_CONTENT_INVALID');
  }
  assertCredentialFreeContent(value, 'OUTBOUND_CREDENTIAL_CONTENT');
  if (
    activeHtmlPattern.test(value) ||
    massMentionPattern.test(value) ||
    teamMentionPattern.test(value) ||
    automationCommandPattern.test(value) ||
    /!\[[^\]]*\]\([^)]+\)/u.test(value)
  ) {
    throw new Error('OUTBOUND_ACTIVE_CONTENT');
  }

  const urls = new Set<string>();
  for (const match of value.matchAll(markdownLinkPattern)) {
    const target = match[1];
    if (target) urls.add(target);
  }
  for (const match of value.matchAll(rawUrlPattern)) {
    const target = match[0];
    if (target) urls.add(target);
  }
  for (const url of urls) assertAllowedUrl(url, options.allowedHosts ?? []);
}

export function assertAllowedLabels(
  requested: readonly string[],
  allowed: readonly string[],
): string[] {
  const selected = [...new Set(requested)];
  if (
    selected.length > 4 ||
    selected.some(
      (label) =>
        !allowed.includes(label) || !label || label.length > 100 || /[\r\n\0]/u.test(label),
    )
  ) {
    throw new Error('OUTBOUND_LABEL_DENIED');
  }
  return selected;
}

function reportLines(report: TriageReportSemantics): string[] {
  if (report.details.length > 5) throw new Error('OUTBOUND_REPORT_INVALID');
  for (const field of [report.headline, ...report.details]) {
    if (!field || /[\r\n]/u.test(field) || commandOrSourcePattern.test(field)) {
      throw new Error('OUTBOUND_REPORT_INVALID');
    }
    assertSafeOutboundText(field, { maxCharacters: field === report.headline ? 160 : 500 });
  }
  return [`### ${report.headline}`, '', ...report.details.map((detail) => `- ${detail}`)];
}

export function renderTriageReport(input: {
  report: TriageReportSemantics;
  state: string;
  stoppedAt: string;
}): string {
  if (!/^[a-z_]{1,40}$/u.test(input.state) || !/^[a-z_]{1,40}$/u.test(input.stoppedAt)) {
    throw new Error('OUTBOUND_REPORT_INVALID');
  }
  const body = [
    ...reportLines(input.report),
    '',
    `Outcome: ${input.state.replaceAll('_', ' ')}`,
    `Completed stage: ${input.stoppedAt.replaceAll('_', ' ')}`,
  ].join('\n');
  assertSafeOutboundText(body, { maxCharacters: 4_000 });
  return body;
}

export function renderProposalComment(input: {
  allowedPreviewHosts: readonly string[];
  branch: string;
  headSha: string;
  preview: {
    reasonCode?: string;
    status: 'failed' | 'ready' | 'skipped';
    urls: readonly string[];
  };
  proposalId: string;
  report?: TriageReportSemantics;
}): string {
  const lines = [
    'A verified fix proposal is ready for testing.',
    '',
    `Proposal: \`${input.proposalId}\``,
    `Branch: \`${input.branch}\``,
    `Commit: \`${input.headSha}\``,
    '',
    `Test the exact branch and commit above, then confirm or reject \`${input.proposalId}\`.`,
  ];
  if (input.report) lines.push('', ...reportLines(input.report));
  if (input.preview.status === 'ready') {
    for (const url of input.preview.urls) {
      assertAllowedUrl(url, input.allowedPreviewHosts);
      lines.push(`Preview: ${url}`);
    }
  } else if (input.preview.status === 'failed') {
    lines.push(`Preview unavailable (${input.preview.reasonCode ?? 'PREVIEW_FAILED'}).`);
  } else {
    lines.push('No preview was configured.');
  }
  const body = lines.join('\n');
  assertSafeOutboundText(body, { allowedHosts: input.allowedPreviewHosts });
  return body;
}

export function renderPullRequestContent(input: {
  allowedHosts?: readonly string[];
  bodyFields: readonly string[];
  proposalId: string;
  title: string;
}): { body: string; title: string } {
  if (input.bodyFields.length < 1 || input.bodyFields.length > 8) {
    throw new Error('OUTBOUND_CONTENT_INVALID');
  }
  assertSafeOutboundText(input.title, { maxCharacters: 160 });
  const body = [
    ...input.bodyFields,
    '',
    `Proposal: \`${input.proposalId}\``,
    '',
    'This pull request was created by the triage agent. It will never merge itself.',
  ].join('\n\n');
  assertSafeOutboundText(body, {
    allowedHosts: input.allowedHosts ?? [],
    maxCharacters: 8_000,
  });
  return { body, title: input.title };
}
