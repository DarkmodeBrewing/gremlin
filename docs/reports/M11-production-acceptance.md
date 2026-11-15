# M11 first-slice production acceptance — 2026-11-15

**PASS**, deployed merged main `214cd3dc2944fd9eeb9f2456655ff051bd1f69e4`
with operator approval. This accepts the first M11 slice, not the full milestone.

Prime and Chat images were built from an archive of that exact revision,
labelled with the commit, and recreated with the existing production Compose
configuration using `--no-deps --no-build`. PostgreSQL's image and start time
were unchanged; its effective restart policy remained `unless-stopped`.

| Smoke check | Result |
|---|---|
| Prime health and database dependency | 200, `ok` |
| Chat health and Prime dependency | 200, `ok`, internally and through published localhost port |
| Unauthenticated operations access | 401 |
| Ordinary principal operations access | 403 |
| Consolidator operations access | 200, `Cache-Control: no-store` |
| Supplied credentials absent from operations response | PASS |
| Source/run counts and last-success timestamp match PostgreSQL | PASS |
| Status polling leaves provider observations unchanged | PASS |
| Authorized read-only memory search | 200, one result |
| Actual embedding HTTP observation after search | `ok`, 200, success timestamp populated |
| Canonical interaction/event row fingerprints before/after smoke requests | Unchanged |

Backlog was zero: 25 succeeded sources, none pending, processing or unresolved
failed. Run totals were 17 succeeded, 2 historical failures, none processing.
Last successful run: `2026-11-15T11:48:24.105Z`. Both application containers
had zero restarts since deployment; the checkout was clean on main.

Consolidation provider state was `not_observed` after startup. No consolidation,
rebuild, source ingestion, schema migration, production failure injection or
rate-limit flooding was performed. HTTP 429 and failure scenarios passed in
isolated integration tests. The read-only search made one bounded embedding
request; status polling itself made none.

Rollback images were retained as `gremlin-prime:pre-m11-214cd3d` and
`gremlin-chat:pre-m11-214cd3d` on DM01. The smoke harness exited 0.

## Normal-use observation

Observe real use over the next few days before claiming sustained operational
stability. Daily read-only checks should record health, backlog, unresolved
failures, latest successful run, provider state/freshness and restart counts.
No activity and unknown/stale provider observations are missing evidence,
not proof of availability. Do not inject conversations or rebuild the corpus
to create a healthy-looking sample. Durable failure visibility and provider
cost accounting remain separate review/deployment work.
