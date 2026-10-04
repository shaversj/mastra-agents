CREATE TABLE IF NOT EXISTS incident_approval_permits (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES incident_cases(id),
  case_version integer NOT NULL CHECK (case_version >= 1),
  attempt_id uuid NOT NULL REFERENCES incident_attempts(id),
  mastra_run_id text NOT NULL,
  suspended_step text NOT NULL,
  manifest_digest text NOT NULL,
  decision_digest text NOT NULL,
  staged_parameters_digest text NOT NULL,
  verification_plan_digest text NOT NULL,
  build_version text NOT NULL,
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  policy_version text NOT NULL,
  catalog_version text NOT NULL,
  collector_version text NOT NULL,
  redaction_version text NOT NULL,
  eligible_roles jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'consumed', 'expired', 'superseded')),
  created_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_case_version integer CHECK (consumed_case_version >= 1),
  actor_id text,
  actor_role text,
  decision text CHECK (decision IN ('approved', 'rejected')),
  reason text,
  UNIQUE (mastra_run_id, suspended_step, decision_digest)
);

CREATE TABLE IF NOT EXISTS incident_workflow_artifacts (
  attempt_id uuid PRIMARY KEY REFERENCES incident_attempts(id),
  case_id uuid NOT NULL REFERENCES incident_cases(id),
  mastra_run_id text NOT NULL,
  suspended_step text NOT NULL,
  decision_digest text NOT NULL,
  staged_parameters_digest text NOT NULL,
  verification_plan_digest text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incident_approval_audit (
  id uuid PRIMARY KEY,
  permit_id uuid NOT NULL UNIQUE REFERENCES incident_approval_permits(id),
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason text NOT NULL,
  decided_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS incident_simulation_outcomes (
  permit_id uuid PRIMARY KEY REFERENCES incident_approval_permits(id),
  attempt_id uuid NOT NULL REFERENCES incident_attempts(id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  executed boolean NOT NULL DEFAULT false CHECK (executed = false),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
