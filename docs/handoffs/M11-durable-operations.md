# M11 durable operations slice

> Current status (2026-11-17): deployed and production verified. See the
> [bounded closeout](../reports/M11-closeout.md) for evidence, scope limits
> and the final PR #21 merge gate. Preparation notes below are historical;
> their pre-deployment statements no longer describe current deployment.

Prepared for review; not deployed. Migration 0010 adds sanitized, append-only
provider HTTP observations. The operations endpoint exposes durable latest
state and 20 recent observations alongside process-local state, plus derived
operator alerts. Success clears the active provider alert without deleting its
history. Persistence failure is visible and does not replace a provider's
original result or trigger a paid retry.

Alerts cover unresolved provider authentication/request failures, telemetry
storage failure, and the documented 30-minute consolidation-stall heuristic.
Alerts are protected status data, not external notifications. No missing-activity
or idle-worker alarm is generated. No new model calls occur during polling.

Validation on 2026-11-15: typecheck/build, 50 unit tests and 47 PostgreSQL/pgvector
integration tests passed in isolated containers, including failure/recovery
across fresh monitor/server instances, bounded history, stalled-work alerts,
fail-open telemetry and existing authorization/rate-limit checks. Disposable
database/network resources were removed. No production migration or failure
injection was performed.

Deploy migration 0010 before the application; verify protected status and health
with read-only smoke tests. Define retention before observations become large;
this slice intentionally does not delete history automatically.
