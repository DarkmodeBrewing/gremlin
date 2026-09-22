ALTER TABLE consolidation_runs
  ADD COLUMN trigger_kind text NOT NULL DEFAULT 'manual'
    CHECK (trigger_kind IN ('manual', 'background'));

CREATE TABLE consolidation_run_event_sources (
  run_id uuid NOT NULL REFERENCES consolidation_runs(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'processing',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (run_id, event_id),
  CONSTRAINT consolidation_run_event_sources_status
    CHECK (status IN ('processing', 'succeeded', 'failed')),
  CONSTRAINT consolidation_run_event_sources_completion
    CHECK (
      (status = 'processing' AND completed_at IS NULL)
      OR (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX consolidation_run_event_sources_active_idx
  ON consolidation_run_event_sources (event_id)
  WHERE status IN ('processing', 'succeeded');

CREATE INDEX consolidation_run_event_sources_retry_idx
  ON consolidation_run_event_sources (event_id, completed_at DESC)
  WHERE status = 'failed';

CREATE INDEX consolidation_run_event_sources_run_idx
  ON consolidation_run_event_sources (run_id, event_id);

CREATE TABLE memory_event_evidence (
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  PRIMARY KEY (memory_id, event_id)
);

CREATE INDEX memory_event_evidence_event_idx
  ON memory_event_evidence (event_id);

CREATE INDEX consolidation_run_sources_retry_idx
  ON consolidation_run_sources (interaction_id, completed_at DESC)
  WHERE status = 'failed';
