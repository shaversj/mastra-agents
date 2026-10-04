CREATE TABLE IF NOT EXISTS incident_evidence_content (
  id text PRIMARY KEY,
  source text NOT NULL,
  source_tier text NOT NULL,
  source_locator text NOT NULL,
  observed_at timestamptz NOT NULL,
  collector_version text NOT NULL,
  redaction_version text NOT NULL,
  canonicalization_version text NOT NULL,
  payload_digest text NOT NULL,
  normalized_payload jsonb,
  freshness text NOT NULL,
  collection_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incident_evidence_observations (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES incident_attempts(id),
  evidence_id text NOT NULL REFERENCES incident_evidence_content(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, id)
);

CREATE TABLE IF NOT EXISTS incident_evidence_manifests (
  id text PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE REFERENCES incident_attempts(id),
  digest text NOT NULL,
  items jsonb NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT now()
);
