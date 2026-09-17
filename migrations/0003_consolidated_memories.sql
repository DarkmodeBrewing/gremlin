ALTER TABLE principals
  ADD COLUMN can_consolidate boolean NOT NULL DEFAULT false;

CREATE TABLE consolidation_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  requested_by text NOT NULL REFERENCES principals(principal_id),
  provider text NOT NULL,
  model text NOT NULL,
  consolidator_version text NOT NULL,
  status text NOT NULL,
  source_count integer NOT NULL DEFAULT 0,
  memory_count integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT consolidation_runs_status
    CHECK (status IN ('processing', 'succeeded', 'failed')),
  CONSTRAINT consolidation_runs_source_count
    CHECK (source_count >= 0),
  CONSTRAINT consolidation_runs_memory_count
    CHECK (memory_count >= 0),
  CONSTRAINT consolidation_runs_completion
    CHECK (
      (status = 'processing' AND completed_at IS NULL AND error_code IS NULL)
      OR (status = 'succeeded' AND completed_at IS NOT NULL AND error_code IS NULL)
      OR (status = 'failed' AND completed_at IS NOT NULL AND error_code IS NOT NULL)
    )
);

CREATE TABLE consolidation_run_sources (
  run_id uuid NOT NULL REFERENCES consolidation_runs(id),
  interaction_id uuid NOT NULL REFERENCES interactions(id),
  status text NOT NULL DEFAULT 'processing',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (run_id, interaction_id),
  CONSTRAINT consolidation_run_sources_status
    CHECK (status IN ('processing', 'succeeded', 'failed')),
  CONSTRAINT consolidation_run_sources_completion
    CHECK (
      (status = 'processing' AND completed_at IS NULL)
      OR (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
    )
);

-- A failed claim may be retried, but an interaction can belong to only one
-- active or successful consolidation run at a time.
CREATE UNIQUE INDEX consolidation_run_sources_active_interaction_idx
  ON consolidation_run_sources (interaction_id)
  WHERE status IN ('processing', 'succeeded');

CREATE INDEX consolidation_run_sources_run_idx
  ON consolidation_run_sources (run_id, interaction_id);

CREATE TABLE embedding_models (
  model_id text PRIMARY KEY,
  provider text NOT NULL,
  dimensions integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT embedding_models_dimensions
    CHECK (dimensions > 0)
);

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  namespace text NOT NULL,
  content text NOT NULL,
  confidence double precision NOT NULL,
  embedding vector NOT NULL,
  embedding_model_id text NOT NULL REFERENCES embedding_models(model_id),
  generated_by text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  consolidation_run_id uuid NOT NULL REFERENCES consolidation_runs(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT memories_namespace_format
    CHECK (
      namespace ~ '^[a-z0-9]+([/-][a-z0-9][a-z0-9-]*)*$'
      AND char_length(namespace) <= 200
    ),
  CONSTRAINT memories_content_not_empty
    CHECK (char_length(content) > 0),
  CONSTRAINT memories_confidence
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT memories_metadata_is_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX memories_namespace_idx
  ON memories (namespace, generated_at, id);

CREATE INDEX memories_embedding_model_idx
  ON memories (embedding_model_id, generated_at, id);

CREATE TABLE memory_evidence (
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id),
  PRIMARY KEY (memory_id, interaction_id)
);

CREATE INDEX memory_evidence_interaction_idx
  ON memory_evidence (interaction_id, memory_id);
