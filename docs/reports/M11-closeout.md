# M11 bounded scope closeout — 2026-11-17

## Decision

The operator requested closeout on 17 November and confirmed that the lack of
recent Chat activity was expected. The planned three-day observation ended
early at the operator's request. Approximately two days of deployed evidence
are available; three completed daily observations are not claimed.

The accepted bounded scope is protected operations status, recovery guidance,
durable sanitized provider HTTP history, derived operator alerts in the status
response, and provider-reported Prime embedding/consolidation usage and costs.
PRs #18–#20 are merged. PR #21 remains the final merge gate: CI and CodeQL must
pass on its final revision, followed by operator-approved merge. No merge was
performed as part of preparing this report.

## Validation and deployment

Typecheck/build, 60 unit tests and 52 real PostgreSQL/pgvector integration tests
passed in isolated containers. Production smoke checks on 15 November passed
health, operations 401/403/200, no-store, sanitized status, polling without
provider calls, durable embedding observation and usage persistence. Canonical
interaction/event fingerprints were unchanged by those smoke checks.

Deployed application revision: `f4236090b9158403122e25d9879b1703c28b9d8a`.
Migrations 0010 and 0011 were applied after taking and inspecting a protected
backup; the prior Prime image was retained. Chat and PostgreSQL were not
restarted for this deployment. This documentation update requires no redeploy.

## Normal-use evidence

Read-only snapshot `2026-11-17T16:42:02.338Z` (17:42 Stockholm):

- Prime, Chat and authenticated operations returned HTTP 200.
- PostgreSQL healthy, `unless-stopped`, zero container restarts, unchanged
  start time `2026-11-15T11:38:43.785757694Z`.
- Backlog, pending, processing and unresolved failed sources all zero.
- Succeeded sources 51, previously 33 on 15 November.
- Runs: 30 succeeded, previously 21; 2 historical failures, unchanged; 0 processing.
- Latest successful run `2026-11-16T10:21:58.829Z`.
- Provider and usage persistence `ok`, no active alerts or provider failure timestamps.
- Latest consolidation HTTP 200 at `2026-11-16T10:21:54.548Z`; embedding HTTP 200
  at `2026-11-16T10:21:58.824Z`. These historical successes were about 30 hours
  old at inspection and do not prove current provider availability.

| Prime kind | Parsed responses | Known cost | Unknown cost | Reported OpenRouter credits |
|---|---:|---:|---:|---:|
| Consolidation | 11 | 11 | 0 | 0.026529066 |
| Embedding | 21 | 21 | 0 | 0.00001006 |

Total reported Prime cost: **0.026539126 credits**, including the original
smoke embedding request. Since the 15 November observation, nine consolidation
and sixteen embedding responses were added. All 32 recorded responses include
reported cost. These aggregates contain no private source content.

Coverage is partial: direct Chat generation, other clients, pre-deployment
traffic, HTTP/transport errors, malformed JSON and telemetry losses are excluded.
No last-24-hour summaries were returned, consistent with the operator's confirmed
inactivity. Idle time is missing fresh evidence, not a provider failure or proof
of readiness. No synthetic activity or paid probes were used during observation.

## Result and follow-ups

Functional tests and production smoke: PASS. Normal-use evidence supports the
bounded scope, with early observation termination explicitly accepted by the
operator. Repository closure remains pending final PR #21 checks and merge.

The original directional M11 list is not claimed complete. External alert
delivery, direct Chat cost coverage, retention policy, broader principal/key
administration and expanded disaster-recovery automation remain deferred.
Existing recovery guidance is retained; no new restore drill is claimed here.

Next proposed workload is M12 declarative client profiles, starting with Chat
and OpenCode: existing identity, namespace grants, ingestion capabilities,
model/provider policy and runtime/network requirements. Profiles must contain
no secrets, must not grant their own authorization, and must not execute
containers. Execution remains outside Prime. Start with configuration validation
and documentation of the two existing clients before adding new integrations.
