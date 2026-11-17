# Memory grounding and namespace fix

## Scope

This fixes three confirmed paths: generated namespaces outside the client's
read policy, isolated follow-ups losing their subject, and assistant recall
errors being consolidated as independent user facts. Examples and test fixtures
use synthetic names and products; no private production conversations are
committed.

The OpenRouter adapter now treats model namespaces as topic labels. An
operator-controlled `CONSOLIDATION_NAMESPACE_ROOTS` JSON map assigns a destination
root to each source principal. For example:

```dotenv
CONSOLIDATION_NAMESPACE_ROOTS='{"client:gremlin-chat":"user"}'
```

A model topic `pets/cats` becomes `user/pets/cats`; an already rooted topic stays
unchanged. Unknown principal roots fail before the provider request. Candidates
with evidence across different configured roots, unknown/assistant evidence,
invalid resulting namespaces or no new user/event evidence fail validation.
This does not grant read access: the operator must select roots consistent with
intended existing grants. Review all source principals, including event sources,
before deployment or a full rebuild. The empty default map intentionally fails
closed when new assertions need consolidation; health checks still work.

Earlier user messages from the same principal and conversation are supplied as
separate context: at most 8 per conversation, 32 overall, and 40,000 characters.
Only records before the earliest new record for that principal/conversation
are eligible. Large records are omitted rather than truncated. Manual,
background and selective consolidation use archived context. Full rebuild uses
only its captured snapshot. Context is neither claimed nor marked processed by
the new run. When cited, it is retained as canonical evidence alongside the new
assertion. Selective supersession still requires complete evidence coverage.

Assistant content is retained in canonical history but excluded from the
extraction input and allowed evidence. Assistant-only batches produce no new
memories and no consolidation-provider call. The extraction instruction requires
explicit user assertions/events, preservation of names and corrections, citation
of contextual user records used to resolve references, and omission of unresolved
subjects. Prior context alone cannot create a memory. Generator version is v3.

## Verification and limits

On 2026-11-17, frozen-lockfile install, typecheck, build, 67 unit tests and
56 PostgreSQL/pgvector integration tests passed. Compose configuration and
`git diff --check` also passed.

Validation uses mocked external HTTP responses and a real disposable
PostgreSQL/pgvector database. Regression coverage includes namespace roots,
unknown/cross-root/assistant/context-only evidence, context isolation and bounds,
follow-up evidence persistence, actual Chat-principal retrieval, denied retrieval
for another principal, and contextual evidence across full-rebuild batches.

These tests prove deterministic boundaries and context delivery, not that a live
language model can never misinterpret a statement. User questions versus
assertions and semantic support still require model interpretation. Context is
bounded and may omit an older antecedent; the instructed behavior is omission,
not guessing. A controlled real-provider acceptance remains a rollout gate.

## Rollout and existing data repair

No schema migration is needed. This branch has not been deployed and does not
change production permissions, canonical sources, or existing derived memories.

1. Review destination roots against source principals and existing read policies.
   Configure the map explicitly; do not broaden grants to make stray topics visible.
2. Run CI, CodeQL and a controlled real-provider acceptance with synthetic
   conversations in isolated storage. Verify new facts through the actual Chat
   principal, complete evidence, no unauthorized retrieval and no assistant-error
   reinforcement. Obtain deployment approval for the reviewed image/configuration.
3. Take and verify a protected backup before any production repair. Identify the
   exact affected derived memories and their complete evidence sets. Prepare a
   selective reconstruction/invalidation plan preserving raw history and old
   evidence with append-only lifecycle records. Review candidates before applying
   the repair. Do not use a broad rebuild as the first response.
4. After repair, verify the user's affected facts through Chat's identity and
   confirm incorrect projections are inactive, the correct relations/product type
   remain, and raw source fingerprints/evidence are preserved.

Deploying this prevention patch alone does not repair existing incorrect or
unreadable projections. No repair, deployment, paid probe or merge is included
in the development validation.
