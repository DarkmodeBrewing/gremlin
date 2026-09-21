ALTER TABLE principals
  ADD COLUMN can_ingest_events boolean NOT NULL DEFAULT false;

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  source_principal text NOT NULL REFERENCES principals(principal_id),
  type text NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT events_type_format
    CHECK (
      type ~ '^[a-z0-9]+([.-][a-z0-9]+)*$'
      AND char_length(type) <= 200
    ),
  CONSTRAINT events_content_not_empty
    CHECK (char_length(content) > 0),
  CONSTRAINT events_metadata_is_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX events_source_principal_idx
  ON events (source_principal, occurred_at, id);

CREATE INDEX events_type_timeline_idx
  ON events (type, occurred_at, id);
