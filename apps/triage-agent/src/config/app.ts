export const appMetadata = {
  agentId: 'triage-coding-agent',
  appId: 'triage-agent',
  packageName: '@mastra-agents/triage-agent',
  scorerId: 'triage-release-gate',
  workflowIds: {
    comment: 'triage-comment-workflow',
    triage: 'triage-workflow',
  },
} as const;
