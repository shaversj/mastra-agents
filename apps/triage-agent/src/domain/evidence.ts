import { z } from 'zod';

import { proposalIdentity, type ProposalIdentity } from './proposal.js';

const proposalSchema = z.object({
  baseSha: z.string(),
  branch: z.string(),
  headSha: z.string(),
  id: z.string().optional(),
});

export const stageResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('not_actionable') }),
  z.object({ outcome: z.literal('missing_reproduction') }),
  z.object({ outcome: z.literal('skipped') }),
  z.object({ outcome: z.literal('unable_to_reproduce') }),
  z.object({ outcome: z.literal('unable_to_fix') }),
  z.object({ outcome: z.literal('verified_fix'), proposal: proposalSchema }),
  z.object({ outcome: z.literal('fix_verified'), proposal: proposalSchema }),
  z.object({ outcome: z.literal('fix_rejected'), proposal: proposalSchema }),
  z.object({ outcome: z.literal('failed') }),
]);

export type StageResult = z.input<typeof stageResultSchema>;
export type MappedStageResult =
  | {
      state:
        | 'failed'
        | 'needs_reproduction'
        | 'not_actionable'
        | 'skipped'
        | 'unable_to_fix'
        | 'unable_to_reproduce';
    }
  | { proposal: ProposalIdentity; state: 'fix_pending' | 'fix_rejected' | 'fix_verified' };

export function mapStageResult(value: StageResult): MappedStageResult {
  const result = stageResultSchema.parse(value);
  switch (result.outcome) {
    case 'not_actionable':
      return { state: 'not_actionable' };
    case 'missing_reproduction':
      return { state: 'needs_reproduction' };
    case 'skipped':
      return { state: 'skipped' };
    case 'unable_to_reproduce':
      return { state: 'unable_to_reproduce' };
    case 'unable_to_fix':
      return { state: 'unable_to_fix' };
    case 'verified_fix':
      return { proposal: proposalIdentity(result.proposal), state: 'fix_pending' };
    case 'fix_verified':
      return { proposal: proposalIdentity(result.proposal), state: 'fix_verified' };
    case 'fix_rejected':
      return { proposal: proposalIdentity(result.proposal), state: 'fix_rejected' };
    case 'failed':
      return { state: 'failed' };
  }
}
