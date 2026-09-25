# Gremlin roadmap

This roadmap records the direction established after the v0.1 architecture was
implemented through M6. Only the active milestone and the next few milestones
are committed. Later stages are directional and must be re-evaluated using
production experience.

The governing rule remains:

> Preserve canonical history, prove the smallest useful vertical slice, then
> iterate.

## Current release — v0.1 "The Hoarder"

### M7 — Cross-client proof

Status: complete — production verified 2026-09-22.

Connect OpenCode as a real second client and model through Gremlin's MCP
endpoint. Prove that information introduced through Gremlin Chat can be
archived, consolidated, retrieved by OpenCode without receiving the original
conversation, and used to answer correctly.

The proof must demonstrate:

- a novel fact enters through Client A / Model A
- the raw interaction is archived
- consolidation creates a derived memory with evidence
- Client B / Model B starts without Client A's conversation history
- Client B retrieves the memory through authenticated MCP
- server-side namespace authorization excludes a known forbidden namespace
- Client B answers correctly using the retrieved memory

M7 does not add new Prime tools, event consolidation, scheduling, OAuth,
memory mutation, or sophisticated authorization.

Production acceptance proved that Gremlin Chat / DeepSeek could contribute a
novel fact and OpenCode / Claude Sonnet could retrieve and use the resulting
authorized memory without receiving Client A's conversation. Retrieval outside
the OpenCode principal's namespace grants remained excluded.

## Release closure

### M8 — v0.1 audit and release

Status: complete — production verified 2026-09-22 and tagged v0.1.0.

Close the specification rather than adding new product scope:

- audit every v0.1 Definition of Done item
- provide the required JSONL export of canonical interactions and events
- verify PostgreSQL backup and restore
- verify API-key rotation and namespace-isolation failure cases
- complete deployment and operational documentation
- tag the accepted revision as v0.1.0

Production acceptance verified canonical export and overwrite protection,
credential rotation with immediate revocation, preserved namespace isolation,
and a full PostgreSQL backup/restore drill with matching row counts and intact
evidence relationships.

## v0.2 — Autonomous and maintainable memory

### M9 — Background consolidation

Status: complete — production verified 2026-09-22.

- execute consolidation without a manual HTTP request
- process both interactions and events
- preserve idempotency and explicit processing state
- make retries and failures visible
- retain the manual trigger for controlled operations
- keep the worker logically separate without introducing unnecessary services

### M10 — Memory lifecycle and reconstruction

Status: Part 1 production verified 2026-09-25 and merged. Part 2 is in progress
on `feat/m10-selective-reconstruction`.

M10 is delivered in three ordered parts:

1. **Lifecycle and active-memory filtering** — record append-only invalidation
   and supersession state, exclude inactive memory from ordinary retrieval, and
   retain authorized historical inspection.
2. **Selective reconstruction** — reconsolidate explicitly selected canonical
   interactions and events, supersede affected active memories only after a
   successful replacement run, and suppress exact duplicates.
3. **Full reconstruction and embedding regeneration** — rebuild derived memory
   from canonical history into staged state, activate it safely, and regenerate
   embeddings when the configured model changes.

Part 1 production acceptance verified capability-gated invalidation, active-only
REST and MCP search plus MCP timeline, preserved authorized historical inspection,
a single append-only lifecycle event, repeat-invalidation conflict, and intact
memory, canonical interaction, and evidence rows. See [M10 handoff](handoffs/M10.md)
for the acceptance record.

Across all three parts, Gremlin must preserve evidence, generator provenance,
canonical source history, and server-side authorization. M10 deliberately does
not introduce semantic contradiction resolution or a temporal belief engine.

Production acceptance of all three parts closes the v0.2 functional scope.
The accepted merge revision can then be tagged v0.2.0.

M9 and M10 are the committed v0.2 sequence.

## Directional stages

These stages are intentionally not locked until M8 through M10 have produced
real operational experience.

### M11 — Operations and observability

- export/import and tested disaster recovery
- readiness and dependency health
- consolidation backlog and failure metrics
- model token and provider cost accounting
- administrative audit records
- principal and API-key lifecycle tooling
- database and embedding migration procedures

### M12 — Declarative client and agent profiles

Describe, but do not execute, the contract for each client:

- principal identity
- readable memory namespaces
- allowed ingestion capabilities
- model/provider policy
- OpenCode and MCP configuration
- runtime and network expectations
- project-specific context

The external runner or shell owns container execution. Gremlin must not
orchestrate Docker and must not receive access to the Docker socket.

### M13 and later — Bounded integrations

Add one vertical integration at a time. Candidate order:

1. Git repository activity
2. CLI/manual event capture
3. infrastructure deployment events
4. brewing observations and measurements
5. calendar, mail, and other external sources

Integrations contribute canonical interactions or events. They do not create
authoritative memories directly.

## Later systems

### SANITY CHECK

Build adversarial multi-model review as a separate Gremlin consumer after
memory lifecycle, provenance, and cost accounting are dependable. Persist the
reviewed answer, participating models, verdict, issues, corrections, and
provenance so the system can later evaluate reviewer usefulness.

### Tasks and Gremlin Puck

Puck remains postponed until Gremlin has stable APIs, a task model, reliable
memory lifecycle, and proven interaction patterns. Puck should become a thin
physical client, not the component that forces Gremlin's domain model into
existence.

## Scope discipline

Before promoting a directional item into an active milestone, answer:

1. What concrete user-visible or operational capability does it prove?
2. What is the smallest vertical slice?
3. Does it preserve canonical history and server-side authorization?
4. Can it be removed or rebuilt without losing raw source information?
5. Is production evidence available to justify it now?
