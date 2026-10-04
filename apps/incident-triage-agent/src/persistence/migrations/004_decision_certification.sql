CREATE TABLE IF NOT EXISTS incident_decision_capsules (
  id text PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE REFERENCES incident_attempts(id),
  capsule jsonb NOT NULL,
  manifest_digest text NOT NULL,
  mastra_workflow_run_id text NOT NULL,
  mastra_gate_result_id text,
  retention_class text NOT NULL CHECK (retention_class = 'governance'),
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS incident_certification_decisions (
  id uuid PRIMARY KEY,
  candidate_bundle text NOT NULL,
  dataset_version text NOT NULL,
  experiment_ids jsonb NOT NULL,
  gate_revision text NOT NULL,
  score_rule text NOT NULL CHECK (score_rule = 'all_items_equal_1'),
  reviewer_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('certified', 'rejected')),
  reason text NOT NULL,
  decided_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS incident_failure_taxonomy (
  id text NOT NULL,
  revision text NOT NULL,
  source_case_count integer NOT NULL CHECK (source_case_count >= 2),
  summary text NOT NULL,
  reduced_input jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, revision)
);
