import { z } from 'zod';

export const incidentClasses = [
  'dependency_outage',
  'bad_deploy',
  'capacity_saturation',
  'noisy_alert',
  'unknown',
] as const;

export const nextActions = [
  'escalate_owner',
  'rollback_release',
  'scale_service',
  'continue_monitoring',
  'request_human_input',
] as const;

export const decisionSchema = z.object({
  incidentClass: z.enum(incidentClasses),
  nextAction: z.enum(nextActions),
  evidenceCitations: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  caveats: z.array(z.string().min(1)).max(10),
  hypotheses: z.array(z.string().min(1)).min(1).max(10),
  rationale: z.string().min(1).max(4000),
  verificationPlan: z.array(z.string().min(1)).min(1).max(10),
});

export type TriageDecision = z.infer<typeof decisionSchema>;
