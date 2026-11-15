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
