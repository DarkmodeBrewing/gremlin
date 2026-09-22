# M9 Production Acceptance Test Report

**Milestone:** M9 — Background Consolidation  
**Project:** Gremlin Prime  
**Date:** 2026-09-22  
**Environment:** Production (`darkmode01`)  
**Branch:** `feat/m9-background-consolidation`  
**Result:** PASS

## Summary

M9 production acceptance completed successfully.

The milestone verified autonomous background consolidation of canonical
interactions and events, typed provenance, source claiming, retry and
cooldown behavior, manual recovery, interrupted-run recovery, and
authorization of the consolidation administration endpoints.

Acceptance was performed against the production PostgreSQL database and
production Gremlin Prime deployment.

The test included controlled provider failure and an actual interruption
of Gremlin Prime while a background consolidation run was in progress.

No partial memories were persisted by failed or interrupted runs.

---

## 1. Migration and Worker Principal

Migration `0006_background_consolidation.sql` was applied successfully.

The production principals were verified:

- `system:consolidator`
  - active: `true`
  - `can_consolidate`: `true`
  - interaction ingestion: `false`
  - event ingestion: `false`
- `agent:opencode`
  - active: `true`
  - `can_consolidate`: `false`
- `client:gremlin-chat`
  - active: `true`
  - `can_consolidate`: `false`

Background consolidation was enabled with:

    BACKGROUND_CONSOLIDATION_ENABLED=true
    CONSOLIDATION_PRINCIPAL_ID=system:consolidator

The running Prime container was verified to have background consolidation
enabled with the expected principal.

**Result:** PASS

---

## 2. Autonomous Background Consolidation

A novel interaction and a novel event were inserted through the production
Prime API.

Interaction:

    id: 01a0ca63-1e63-7134-88ca-02086a132bcc
    conversation: 6ee44ecb-e069-438a-bd19-ec68e0e82597
    source: agent:opencode
    content: M9 acceptance marker: the autonomous hoarder wears purple socks.

Event:

    id: 01a0ca63-3d95-710a-bc34-6f1625c7e228
    source: agent:opencode
    type: acceptance.m9
    content: M9 background consolidation acceptance event: brass turnip.

No manual consolidation request was issued.

The background worker automatically created and completed:

    run: 01a0ca66-3533-77a6-9db7-fcba1856b515
    trigger: background
    status: succeeded
    source_count: 3
    memory_count: 3

The batch contained the two new M9 sources plus one previously unclaimed
canonical event.

**Result:** PASS

---

## 3. Interaction and Event Provenance

The M9 background run generated separate memories for the novel interaction
and event.

Interaction-derived memory:

    memory: 01a0ca66-6e72-7778-a05d-c21e7efb6990
    namespace: acceptance-tests/m9
    evidence interaction:
      01a0ca63-1e63-7134-88ca-02086a132bcc

Event-derived memory:

    memory: 01a0ca66-6e77-72fa-874c-c1c0171aca42
    namespace: acceptance-tests/m9
    evidence event:
      01a0ca63-3d95-710a-bc34-6f1625c7e228

Retrieval through the Prime API verified typed evidence.

The interaction-derived memory returned:

    evidenceInteractionIds:
      - 01a0ca63-1e63-7134-88ca-02086a132bcc
    evidenceEventIds: []

The event-derived memory returned:

    evidenceInteractionIds: []
    evidenceEventIds:
      - 01a0ca63-3d95-710a-bc34-6f1625c7e228

This also exposed a stale production build artifact during testing.
The source implementation already returned both evidence types. Prime was
rebuilt and redeployed, after which the production API returned the expected
typed provenance.

**Result:** PASS

---

## 4. Successful Source Claiming

The M9 interaction and event were verified as successfully claimed by the
background consolidation run.

Each canonical source had exactly one successful claim.

Subsequent worker polling produced neither:

- duplicate memories
- duplicate successful claims
- empty consolidation runs

**Result:** PASS

---

## 5. Controlled Provider Failure

A fresh interaction was created for provider-failure testing:

    interaction:
      01a0ca7e-0c13-7230-af43-375a382887d8

OpenRouter authentication was deliberately made invalid for Gremlin Prime
while retaining a schema-valid configuration.

The background worker claimed the source and attempted consolidation.

Observed failed run:

    run: 01a0ca7e-54ee-7b26-87ba-57495abad403
    trigger: background
    requested_by: system:consolidator
    status: failed
    source_count: 1
    memory_count: 0
    error_code: provider_failure
    created_at: 2026-09-22 19:01:12.042617+00
    completed_at: 2026-09-22 19:01:12.281169+00

No partial memory was persisted.

**Result:** PASS

---

## 6. Automatic Retry Cooldown

The configured retry delay was:

    CONSOLIDATION_RETRY_DELAY_MS=300000

After the provider failure, another normal worker poll was allowed to occur
while the failed source remained inside the five-minute retry cooldown.

A database query showed only the original failed background run.

No second consolidation run was created for the source.

This demonstrated that a failed source is retained for retry while automatic
reprocessing is suppressed during the configured cooldown.

**Result:** PASS

---

## 7. Manual Recovery During Cooldown

The valid provider configuration was restored.

Before the five-minute automatic retry cooldown had expired, the existing
manual consolidation endpoint was invoked.

Manual recovery run:

    run: 01a0ca81-38e6-7595-bf19-112f9b519753
    trigger: manual
    status: succeeded
    source_count: 1
    memory_count: 0
    created_at: 2026-09-22 19:04:21.475115+00
    completed_at: 2026-09-22 19:04:24.124341+00

The provider elected not to produce a new memory for the source. The
consolidation operation itself completed successfully.

Source history confirmed that the exact same canonical interaction was
reclaimed:

    interaction:
      01a0ca7e-0c13-7230-af43-375a382887d8

First attempt:

    trigger: background
    run: 01a0ca7e-54ee-7b26-87ba-57495abad403
    source status: failed

Recovery attempt:

    trigger: manual
    run: 01a0ca81-38e6-7595-bf19-112f9b519753
    source status: succeeded

The manual retry began approximately three minutes after the original
failure, proving that manual consolidation bypasses the automatic retry
cooldown.

**Result:** PASS

---

## 8. Interrupted Run Recovery

A fresh canonical interaction was inserted for interruption testing.

The background worker claimed it and entered an active processing state:

    run: 01a0ca85-40b0-75fc-b48b-f410784e4c22
    trigger: background
    status: processing
    source_count: 1
    memory_count: 0
    completed_at: NULL

Gremlin Prime was then deliberately stopped with SIGTERM while provider work
was in progress.

The shutdown interrupted the in-flight worker. No memory was persisted.

Prime was restarted.

Startup recovery logged:

    operation: consolidation.recovery
    recoveredRunCount: 1
    message: Recovered interrupted consolidation runs

The abandoned run was recovered as:

    run: 01a0ca85-40b0-75fc-b48b-f410784e4c22
    status: failed
    source_count: 1
    memory_count: 0
    error_code: interrupted
    completed_at: 2026-09-22 19:10:20.814092+00

The associated source was:

    interaction:
      01a0ca84-ae04-776b-8838-0df4747361d8
    source status: failed
    completed_at: 2026-09-22 19:10:20.814092+00

This test exercised actual process interruption rather than creating an
artificial processing row directly in PostgreSQL.

The abandoned source was left in a failed/retryable state and no partial
memory was created.

**Result:** PASS

---

## 9. Consolidation Run Administration API

The authorized consolidator principal requested:

    GET /admin/consolidation/runs?limit=20

The endpoint returned:

    HTTP 200

The response contained bounded operational run metadata including:

- run ID
- trigger kind
- status
- source count
- memory count
- error code
- creation timestamp
- completion timestamp

The response did not expose canonical interaction or event content.

The response included both successful and failed production runs, including:

    01a0ca85-40b0-75fc-b48b-f410784e4c22
      background / failed / interrupted

    01a0ca81-38e6-7595-bf19-112f9b519753
      manual / succeeded

    01a0ca7e-54ee-7b26-87ba-57495abad403
      background / failed / provider_failure

    01a0ca66-3533-77a6-9db7-fcba1856b515
      background / succeeded

**Result:** PASS

---

## 10. Administration Authorization

`client:gremlin-chat` is an active production principal but does not have
`can_consolidate`.

Using its valid API credential:

    GET /admin/consolidation/runs?limit=20

returned:

    HTTP 403

Using the same principal:

    POST /admin/consolidate

returned:

    HTTP 403

The authorized `system:consolidator` principal successfully accessed the
administration API.

This verifies that both consolidation administration endpoints enforce the
`can_consolidate` capability rather than merely requiring an authenticated
principal.

**Result:** PASS

---

## 11. Automated Verification

M9 was verified using the repository's normal verification pipeline in a
disposable Node 24 / pnpm 11.19.0 environment.

Verification included:

    pnpm install --frozen-lockfile
    pnpm typecheck
    pnpm test
    pnpm build

PostgreSQL integration tests included coverage for:

- autonomous interaction and event consolidation
- typed evidence
- retry cooldown
- manual recovery
- automatic retry attempt limits
- interrupted-run recovery

The retry integration test independently verified that repeated background
ticks inside the retry delay do not create additional failed runs, while
manual consolidation remains able to reclaim the source.

**Result:** PASS

---

## 12. Operational Observations

Several operational issues were discovered and resolved during acceptance.

### Stale migration image

Migration `0006_background_consolidation.sql` was initially not applied
because the production migration image was stale.

The migration image was rebuilt and the migration then applied successfully.

### Stale Prime build

The initially deployed Prime artifact did not expose event evidence through
memory retrieval even though the source implementation and integration tests
already supported it.

Prime was rebuilt and redeployed. Production retrieval then returned both
`evidenceInteractionIds` and `evidenceEventIds` correctly.

### MCP credential persistence

A previously rotated `agent:opencode` credential had been verified during M8
but its replacement had not been persisted to `.env`.

The principal was rotated again and the current credential was persisted as
`GREMLIN_MCP_KEY`.

The operational rotation sequence should therefore be:

1. rotate credential
2. persist replacement secret
3. verify new credential
4. verify old credential is rejected
5. remove temporary credential material

### Local production artifacts

The production verification process created local package-manager cache and
backup directories.

The following paths are local operational artifacts and must remain outside
Git:

    .pnpm-store/
    backups/

Production database backups must never be committed to the repository.

---

## Acceptance Matrix

| Requirement | Result |
|---|---|
| M9 migration applied | PASS |
| Worker principal exists, active and authorized | PASS |
| Background worker enabled in production | PASS |
| Interaction automatically claimed | PASS |
| Event automatically claimed | PASS |
| Background consolidation succeeds without manual trigger | PASS |
| Interaction evidence preserved | PASS |
| Event evidence preserved | PASS |
| Successful sources not reclaimed automatically | PASS |
| Empty background runs suppressed | PASS |
| Provider failure recorded | PASS |
| Failed run produces no partial memory | PASS |
| Automatic retry cooldown enforced | PASS |
| Manual consolidation bypasses cooldown | PASS |
| Interrupted processing run recovered on startup | PASS |
| Interrupted source remains retryable | PASS |
| Admin run endpoint returns bounded operational state | PASS |
| Admin run endpoint exposes no source content | PASS |
| Unauthorized admin GET rejected | PASS |
| Unauthorized admin POST rejected | PASS |

---

## Final Result

**M9 — Background Consolidation: PASS**

Production acceptance demonstrates that Gremlin Prime can autonomously
consolidate canonical interactions and events while preserving typed
provenance and source ownership.

Successful sources are not processed repeatedly. Provider failures are
recorded without partial derived state, automatic retries respect the
configured cooldown and attempt policy, and operators retain an explicit
manual recovery path.

An actual Prime interruption during an active background consolidation was
successfully recovered on restart. The abandoned run was marked
`failed/interrupted`, its source was returned to a retryable failed state,
and no partial memory survived the interruption.

The consolidation administration surface is capability-protected and exposes
operational state without exposing canonical source content.

M9 is accepted for production.
