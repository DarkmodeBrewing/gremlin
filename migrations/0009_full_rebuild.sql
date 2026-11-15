ALTER TABLE consolidation_runs DROP CONSTRAINT consolidation_runs_trigger_kind_check;
ALTER TABLE consolidation_runs ADD CONSTRAINT consolidation_runs_trigger_kind_check
  CHECK (trigger_kind IN ('manual', 'background', 'reconstruction', 'full_rebuild'));

CREATE TABLE memory_rebuilds (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  consolidation_run_id uuid NOT NULL UNIQUE REFERENCES consolidation_runs(id),
  requested_by text NOT NULL REFERENCES principals(principal_id),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'succeeded', 'failed')),
  source_count integer NOT NULL DEFAULT 0,
  memory_count integer NOT NULL DEFAULT 0,
  embedding_model_id text REFERENCES embedding_models(model_id),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (source_count >= 0 AND memory_count >= 0),
  CHECK ((status = 'processing' AND completed_at IS NULL AND error_code IS NULL)
    OR (status = 'succeeded' AND completed_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL AND error_code IS NOT NULL))
);
CREATE UNIQUE INDEX memory_rebuilds_one_processing_idx ON memory_rebuilds ((true))
  WHERE status = 'processing';

CREATE TABLE memory_rebuild_interactions (
  rebuild_id uuid NOT NULL REFERENCES memory_rebuilds(id),
  interaction_id uuid NOT NULL REFERENCES interactions(id),
  PRIMARY KEY (rebuild_id, interaction_id)
);
CREATE TABLE memory_rebuild_events (
  rebuild_id uuid NOT NULL REFERENCES memory_rebuilds(id),
  event_id uuid NOT NULL REFERENCES events(id),
  PRIMARY KEY (rebuild_id, event_id)
);
ALTER TABLE memories ADD COLUMN rebuild_id uuid REFERENCES memory_rebuilds(id);
CREATE INDEX memories_rebuild_idx ON memories (rebuild_id) WHERE rebuild_id IS NOT NULL;

-- Pin search to the current model while a replacement is generated with a new one.
CREATE TABLE memory_embedding_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_model_id text REFERENCES embedding_models(model_id)
);
INSERT INTO memory_embedding_state (singleton, active_model_id)
VALUES (true, (
  SELECT m.embedding_model_id FROM memories m
  WHERE NOT EXISTS (SELECT 1 FROM memory_lifecycle_events lifecycle WHERE lifecycle.memory_id = m.id)
  ORDER BY m.generated_at DESC, m.id DESC LIMIT 1
));
