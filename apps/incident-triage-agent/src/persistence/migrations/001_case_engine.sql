CREATE TABLE IF NOT EXISTS incident_schema_migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incident_cases (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  source_incident_id text NOT NULL,
  state text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_incident_id)
);

CREATE TABLE IF NOT EXISTS incident_deliveries (
  source text NOT NULL,
  delivery_id text NOT NULL,
  source_incident_id text NOT NULL,
  case_id uuid REFERENCES incident_cases(id),
  attempt_id uuid,
  redacted_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, delivery_id)
);

CREATE TABLE IF NOT EXISTS incident_attempts (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES incident_cases(id),
  delivery_source text NOT NULL,
  delivery_id text NOT NULL,
  state text NOT NULL,
  mastra_run_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_source, delivery_id),
  FOREIGN KEY (delivery_source, delivery_id) REFERENCES incident_deliveries(source, delivery_id)
);

ALTER TABLE incident_deliveries
  DROP CONSTRAINT IF EXISTS incident_deliveries_attempt_id_fkey;
ALTER TABLE incident_deliveries
  ADD CONSTRAINT incident_deliveries_attempt_id_fkey
  FOREIGN KEY (attempt_id) REFERENCES incident_attempts(id);

CREATE TABLE IF NOT EXISTS incident_case_transitions (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES incident_cases(id),
  attempt_id uuid NOT NULL REFERENCES incident_attempts(id),
  from_state text,
  to_state text NOT NULL,
  case_version integer NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  actor_id text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, case_version)
);

CREATE TABLE IF NOT EXISTS incident_outbox (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('start_workflow', 'resume_workflow')),
  attempt_id uuid NOT NULL REFERENCES incident_attempts(id),
  status text NOT NULL CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
  dispatch_attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_generation integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, attempt_id)
);

CREATE INDEX IF NOT EXISTS incident_outbox_dispatch_idx
  ON incident_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'leased');
