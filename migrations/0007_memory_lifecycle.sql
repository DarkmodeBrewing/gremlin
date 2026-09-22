CREATE TABLE memory_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
  action text NOT NULL,
  reason text NOT NULL,
  requested_by text NOT NULL REFERENCES principals(principal_id),
  superseding_memory_id uuid REFERENCES memories(id) ON DELETE RESTRICT,
  superseding_run_id uuid REFERENCES consolidation_runs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_lifecycle_events_action
    CHECK (action IN ('invalidated', 'superseded')),
  CONSTRAINT memory_lifecycle_events_reason
    CHECK (char_length(reason) BETWEEN 1 AND 2000),
  CONSTRAINT memory_lifecycle_events_not_self_superseding
    CHECK (
      superseding_memory_id IS NULL
      OR superseding_memory_id <> memory_id
    ),
  CONSTRAINT memory_lifecycle_events_supersession_reference
    CHECK (
      action <> 'superseded'
      OR superseding_memory_id IS NOT NULL
      OR superseding_run_id IS NOT NULL
    ),
  CONSTRAINT memory_lifecycle_events_invalidation_reference
    CHECK (
      action <> 'invalidated'
      OR (
        superseding_memory_id IS NULL
        AND superseding_run_id IS NULL
      )
    ),
  UNIQUE (memory_id)
);

CREATE INDEX memory_lifecycle_events_requested_by_idx
  ON memory_lifecycle_events (requested_by, created_at DESC, id DESC);

CREATE INDEX memory_lifecycle_events_superseding_memory_idx
  ON memory_lifecycle_events (superseding_memory_id)
  WHERE superseding_memory_id IS NOT NULL;

CREATE INDEX memory_lifecycle_events_superseding_run_idx
  ON memory_lifecycle_events (superseding_run_id)
  WHERE superseding_run_id IS NOT NULL;
