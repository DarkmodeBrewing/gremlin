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

Status: Parts 1 and 2 production verified 2026-09-25. Part 2 is in PR #12;
Part 3 is next after its merge.

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

Part 2 production acceptance verified explicit interaction/event reconstruction,
complete evidence-set protection, exact active deduplication, append-only
supersession linked to the successful run, authorization, and intact canonical
history. Failure and concurrent-claim behavior is covered by PostgreSQL
integration tests. See the [M10 handoff](handoffs/M10.md) for the acceptance
record.

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

### M14 — Persistent Missions

Status: directional — product direction recorded 2026-10-08.

Give Gremlin durable objectives, continuity, policies, approval rules, triggers,
state and history across disposable executions. Gremlin owns Mission state;
Runner owns execution lifecycle. Prime does not orchestrate Docker.

Start with one objective and one bounded trigger. See the
[Mission, Initiative and HealthKit design](designs/initiative-and-healthkit.md)
for dependencies and acceptance criteria.

### M15 — Conversational Initiative

Status: directional — product direction recorded 2026-10-08.

Allow Gremlin to initiate actual conversations from authorized memories,
events, observations, unfinished discussions and spontaneous associations.
Topics need not have been explicitly selected for monitoring; occasional
low-stakes curiosity is allowed within user-defined boundaries.

Persist a conversation proposal before delivery. Evaluate evidence, novelty,
relevance and timing; enforce quiet hours, cooldowns, topic controls and cost
budgets. Keep proposal, delivery, reply and follow-up continuity independent
of model executions. Retain evidence for “Why did you bring this up?”

Start with an in-app opener based on existing conversation history. A Mission
reference is optional; HealthKit and push notifications are not prerequisites.
See the [detailed design](designs/initiative-and-healthkit.md).

### M16 — Native iOS HealthKit ingestion

Status: directional — product direction recorded 2026-10-08.

Add a native-capable iOS adapter that reads selected, user-authorized HealthKit
data and contributes meaningful canonical events through authenticated Gremlin
ingestion. This is a bounded integration following M13's source rules.

Begin with one metric and foreground synchronization. Prove idempotent retries,
source provenance, incremental corrections/retractions, health-specific access
boundaries and visible freshness before background synchronization.

Deterministic, rebuildable observations may supply M15 proposals. Health
ingestion is independently useful and does not itself enable unsolicited
health conversations. See the [detailed design](designs/initiative-and-healthkit.md).

M14–M16 are provisional planning identifiers. They extend the directional
roadmap without locking implementation order, release scope or delivery dates.

## Later systems

### SANITY CHECK

Build adversarial multi-model review as a separate Gremlin consumer after
memory lifecycle, provenance, and cost accounting are dependable. Persist the
reviewed answer, participating models, verdict, issues, corrections, and
provenance so the system can later evaluate reviewer usefulness.

### Tasks and Gremlin Puck

M14 makes the persistent Mission direction explicit; M15 adds conversational
initiative as its own capability, including proposals without a Mission.
Chat/Puck presents conversations and feedback while Gremlin owns durable state.

Puck remains a thin client over stable Gremlin APIs. The existing PWA/desktop
direction need not wait for HealthKit; M16 supplies a concrete requirement for
a native iOS adapter. Its shell/framework is an open decision, not a replacement
of the current client plan. See the
[dependency and ownership design](designs/initiative-and-healthkit.md).

## Scope discipline

Before promoting a directional item into an active milestone, answer:

1. What concrete user-visible or operational capability does it prove?
2. What is the smallest vertical slice?
3. Does it preserve canonical history and server-side authorization?
4. Can it be removed or rebuilt without losing raw source information?
5. Is production evidence available to justify it now?
