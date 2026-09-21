CREATE TABLE principal_memory_read_policies (
  principal_id text NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  namespace_prefix text NOT NULL,
  include_descendants boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, namespace_prefix, include_descendants),
  CONSTRAINT principal_memory_read_policies_namespace_format
    CHECK (
      namespace_prefix ~ '^[a-z0-9]([a-z0-9/-]*[a-z0-9])?$'
      AND namespace_prefix NOT LIKE '%//%'
      AND namespace_prefix NOT LIKE '%--%'
      AND namespace_prefix NOT LIKE '%/-%'
      AND namespace_prefix NOT LIKE '%-/%'
      AND char_length(namespace_prefix) <= 200
    )
);

CREATE INDEX principal_memory_read_policies_lookup_idx
  ON principal_memory_read_policies (principal_id, namespace_prefix);
