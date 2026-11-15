CREATE TABLE provider_observations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL CHECK (kind IN ('embedding', 'consolidation')),
  status text NOT NULL CHECK (status IN ('ok', 'authentication_failed', 'rate_limited', 'unavailable', 'request_failed')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  observed_at timestamptz NOT NULL
);
CREATE INDEX provider_observations_kind_latest_idx ON provider_observations (kind, observed_at DESC, id DESC);
CREATE INDEX provider_observations_time_idx ON provider_observations (observed_at DESC, id DESC);
