# M11 operations status and recovery

## Status contract

`GET /health` remains a cheap database/dependency health check. HTTP 200 does
not establish that a model provider accepts the current credential.

`GET /admin/operations` requires an active principal with `can_consolidate`.
It uses the normal pre-authentication rate limit and returns `Cache-Control:
no-store`. No model request is made by polling it.

The response contains:

- `providers.consolidation` and `providers.embedding`: the last observed HTTP
  result, HTTP status, observation time, and last success/failure timestamps.
  HTTP 401/403 is `authentication_failed`, 429 is `rate_limited`, transport
  errors and HTTP 5xx are `unavailable`, other unsuccessful responses are
  `request_failed`, and successful HTTP responses are `ok`.
- `consolidation.backlog`: distinct sources pending their first successful
  ordinary consolidation, including failed sources. Retry delays and attempt
  limits mean this is not a count of immediately runnable work.
- `consolidation.sources`: pending, processing, failed and succeeded source
  counts across interactions and events. Multiple failed attempts count once;
  a later successful attempt removes a source from failed backlog.
- `consolidation.runs`: all-time processing, failed and succeeded run counts,
  including manual, background, reconstruction and full-rebuild runs.
- `consolidation.lastSuccessfulRunAt` and the ten most recent run summaries.

Provider observations are process-local and reset to `not_observed` after a
restart. Consult `observedAt`; an old observation is not current availability.
Only calls through Prime's configured provider clients are observed. Provider
HTTP success does not validate model output or persistence: inspect run status
as well. These observations are not a readiness gate, a credential-expiry
forecast, or durable provider history. No headers, credentials, prompt/source
content, response bodies or raw exception text are retained in observations.

After deployment, call the endpoint with an operator key using the existing
secure credential mechanism. Do not paste keys into shell history or enable
shell tracing. Never send the result to an ordinary memory namespace.

## PostgreSQL stopped or Prime restarting

1. Inspect `docker compose ps -a` and the recent Prime/PostgreSQL logs. Avoid
   printing environment/configuration values or private source content.
2. If the existing PostgreSQL container is stopped, confirm that its named
   data volume remains attached. Do not run `down --volumes`, delete the
   volume, initialize a replacement database, or run acceptance truncation
   tests against production.
3. Start the existing service with `docker compose start postgres` using the
   existing production Compose files. Check PostgreSQL readiness and Prime's
   `/health` after the application's retry interval.
4. Validate configuration with `docker compose config --quiet`. The effective
   PostgreSQL restart policy must be `unless-stopped`. For an existing
   container, `docker update --restart unless-stopped gremlin-postgres-1`
   applies this policy without recreating the database or restarting it.
   The Compose file must also retain the policy for future recreation.
5. Inspect the running container's restart policy and health. An explicitly
   stopped container stays stopped by design; this policy is not a healthcheck
   restarter. Investigate recurring failure rather than masking it with retries.

Container names above refer to the DM01 deployment; confirm names before use.
The internal database hostname is `postgres`. A host/VPN address used for
published client ports is not a substitute for internal service discovery.

## Expired or rejected provider key

1. Inspect provider observations and failed run summaries. A 401/403 indicates
   authentication/authorization rejection; do not repair this by rebuilding
   the corpus or changing database networking.
2. Renew the credential through the provider and update the protected `.env`
   on the deployment host. Keep it out of Git, logs, memory and chat transcripts.
3. Recreate Prime and Chat with the existing production Compose files:
   `docker compose up -d --no-deps --no-build gremlin-prime gremlin-chat`.
   A plain container restart does not reload environment values from `.env`.
4. Verify Prime and Chat health. Provider observations initially become
   `not_observed`; verify recovery through an intended normal operation or a
   deliberate bounded provider check, considering its cost. Do not trigger a
   full rebuild merely to test a credential.
5. Inspect backlog and recent run outcomes after normal processing resumes.
   Exhausted retries need deliberate handling; do not delete failed history or
   raw source records. Before an intentional rebuild or model migration,
   follow the M10 protocol, verify both old and new model availability, and
   take a protected backup.

## Acceptance and deployment

Validate unauthorized 401, ordinary-principal 403, pre-authentication 429,
empty state, failed retry deduplication, recovery after a success, and provider
classification in the unit/PostgreSQL integration suites. Use disposable
storage for fixtures and failure injection. Production smoke checks should be
read-only and confirm provider observations are distinct from `/health`.

M11 endpoints require deployment of the M11 code; tagging v0.2.0 or updating
only the database restart policy does not install them.

## Durable provider history and operator alerts

After migration `0010_provider_observations.sql`, Prime appends fixed provider
HTTP classifications to PostgreSQL. `providerHistory.latest` and the most
recent 20 observations survive restarts; `providers` remains process-local.
A successful subsequent request clears the active provider alert while keeping
failure/recovery history. No request URLs, headers, source content, response
bodies or exception messages are stored. This table grows with requests;
retention/export is a subsequent operational decision, not an automatic purge.

The protected operations response includes `alerts` for unresolved provider
failures, provider-telemetry persistence failure, or consolidation stalled for
30 minutes. Stalled means an old processing run, or an unresolved source at
least 30 minutes old with no successful run in the last 30 minutes. It is a
heuristic, not proof that the worker is dead. Empty backlog and missing provider
activity alone do not alert. Inspect timestamps; persistent failures can remain
unresolved after a restart until a real request verifies recovery.

Alerts are operator status data only: no email, chat messages or notification
service is configured. `providerTelemetry` reports the current process's
persistence status. Observation storage failures are fail-open and do not
change the original provider response or trigger a paid retry. Do not infer
complete provider history while telemetry is unavailable. Deploy migration
0010 before starting this code; no existing migration is edited.

## Prime provider cost accounting (subsequent slice)

After migration 0011 and deployment of the cost slice, protected operations
status includes `usage`, grouped by provider kind for all-time and the last
24 hours, plus `usageTelemetry`. Accounting uses only provider-reported
`usage.cost` and safe nonnegative integer token fields, following
[OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting).
It does not estimate prices or make billing API calls.

`reportedCostCredits` is a decimal string summed in PostgreSQL; zero means a
reported zero. Missing, invalid or unreported cost stays null/unknown.
`parsedResponses`, `reportedCostResponses` and `unknownCostResponses` disclose
coverage. Token totals are also partial sums of valid reported fields.
This is partial Prime telemetry, not an account-wide bill: it excludes Chat's
direct generation, other clients, pre-deployment history, transport/HTTP-error
responses, malformed JSON, and rows lost during telemetry-storage outages.
It includes successfully parsed HTTP responses even if later model-output
validation fails, because such requests may still have been billed.

A `provider_usage_unavailable` alert signals current-process storage failure;
recording is fail-open and never retries a paid provider request. Successful
storage clears the active storage alert, not the historical gap. Rows persist
across restarts but are not backfilled or reconciled with the provider account.
Migration 0011 must precede deployment; review this slice after durable
operations and the normal-use observation period. No cost threshold, automatic
provider switching, outbound alert, or spending decision is added here.
