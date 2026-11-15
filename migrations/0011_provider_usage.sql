CREATE TABLE provider_usage (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL CHECK (kind IN ('embedding', 'consolidation')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  cost_credits numeric CHECK (cost_credits >= 0 AND cost_credits <= 1000000000),
  prompt_tokens bigint CHECK (prompt_tokens >= 0),
  completion_tokens bigint CHECK (completion_tokens >= 0),
  total_tokens bigint CHECK (total_tokens >= 0)
);
CREATE INDEX provider_usage_time_idx ON provider_usage (recorded_at DESC, kind);
