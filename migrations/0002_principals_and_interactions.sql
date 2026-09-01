CREATE TABLE principals (
  principal_id text PRIMARY KEY,
  api_key_hash text NOT NULL UNIQUE,
  can_ingest_interactions boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT principals_id_format
    CHECK (principal_id ~ '^(client|agent|system):[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT principals_api_key_hash_format
    CHECK (api_key_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE interactions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  conversation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  source_principal text NOT NULL REFERENCES principals(principal_id),
  role text NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT interactions_role
    CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  CONSTRAINT interactions_content_not_empty
    CHECK (char_length(content) > 0),
  CONSTRAINT interactions_metadata_is_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX interactions_conversation_timeline_idx
  ON interactions (conversation_id, occurred_at, id);

CREATE INDEX interactions_source_principal_idx
  ON interactions (source_principal, created_at, id);
