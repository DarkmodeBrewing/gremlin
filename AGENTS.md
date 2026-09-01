AGENTS.md — Gremlin

## Canonical specification

The canonical specification for the current release is:

`docs/v0.1_spec.md`

Read it before making architectural or scope decisions.

Purpose

This document defines the working rules for AI coding agents contributing to the Gremlin repository.

Gremlin is persistent personal AI infrastructure. Correctness, data integrity, security boundaries and maintainability matter more than implementation speed.

The canonical Gremlin Stack v0.1 — The Hoarder specification defines the product and architectural scope.

Agents must implement that specification rather than redesign it.

⸻

1. Prime Directive

Do not YOLO. Apply YAGNI.

Work deliberately.

Prefer the smallest correct implementation that satisfies the current requirement.

Do not introduce infrastructure, abstractions, frameworks or features because they might become useful later.

At the same time, do not take shortcuts that compromise:

* canonical source data
* data integrity
* provenance
* authentication
* authorization
* security boundaries
* rebuildability of derived data

Simple is good.

Careless is not simple.

⸻

2. The Specification Is Authoritative

The canonical v0.1 specification is the source of truth for architecture and scope.

Before making architectural decisions:

1. Consult the specification.
2. Determine whether the decision has already been made.
3. Follow the existing decision if one exists.

Do not silently reinterpret the specification.

If implementation reveals a genuine conflict, missing requirement or architectural problem, surface it explicitly before changing the architecture.

Implementation details not constrained by the specification may be chosen autonomously.

⸻

3. Protect the Architectural Invariants

The following invariants must not be violated:

1. The model does not own memory.
2. The client does not own memory.
3. Gremlin Prime owns the canonical historical corpus.
4. Raw source material is preserved independently of derived memory.
5. Derived memory can be rebuilt.
6. Every source is attributable to a principal.
7. Every agent contributes to shared history through authorized ingestion.
8. Every agent receives only authorized memory.
9. Authorization is enforced by Gremlin Prime, never by the model.
10. Normal agents cannot directly create authoritative long-term memories.

If an implementation would violate one of these principles, stop and reconsider the implementation.

⸻

4. Raw Data Is Sacred

Interactions and events are canonical source material.

Treat them as append-only.

Do not:

* silently mutate source records
* rewrite historical content
* replace old observations with newer interpretations
* delete source records as part of ordinary application behavior

Corrections should normally be represented by additional source information.

Administrative deletion may exist where explicitly required, but must be deliberate and auditable.

Derived information may be regenerated.

Raw historical information must not depend on derived information for reconstruction.

⸻

5. Derived Data Must Be Rebuildable

Memories, embeddings, summaries and future derived structures are disposable projections over canonical source data.

Never design a derived structure such that deleting it destroys information required to reconstruct it.

Every derived memory must retain provenance linking it to supporting source material.

When practical, derived records should also identify:

* generating component
* generating model
* generating version
* generation timestamp

A future implementation must be able to say:

Delete the derived state and rebuild it from history.

⸻

6. Authorization Is a Server-Side Boundary

Never rely on an LLM, client application or prompt to enforce access control.

Authorization belongs inside Gremlin Prime.

Memory retrieval must be constrained to namespaces accessible by the authenticated principal before results leave Gremlin Prime.

Do not:

1. retrieve everything
2. send it to the model
3. ask the model to ignore unauthorized information

That is not authorization.

⸻

7. Authentication Identity Is Not User Input

Clients authenticate as registered principals.

Examples:

client:gremlin-chat
agent:hermes
agent:opencode
system:consolidator

Never trust a principal identifier supplied in ordinary request payload data.

The authenticated credential determines the principal.

Request data does not.

⸻

8. Secrets Never Become Memory

Never persist credentials in:

* interactions
* events
* memories
* embeddings
* logs
* model prompts
* test fixtures committed to Git

This includes:

* API keys
* database credentials
* authorization headers
* tokens
* passwords
* private keys

Sanitize potentially sensitive metadata before persistence.

### Rate Limits Are Canon

Every externally reachable Gremlin Prime API endpoint except operational health checks must be rate-limited before authentication, database access or other expensive work.

Rate limiting is a server-side boundary. Do not rely solely on clients, models or an ingress proxy to enforce it.

Tests must verify limit enforcement and the `429` response contract. A process-local store is acceptable only while Gremlin Prime runs as a single instance; use a shared store before horizontal scaling.

⸻

9. YAGNI

Do not implement functionality merely because the architecture might support it eventually.

For v0.1, explicitly avoid implementing unless required by the canonical specification:

* knowledge graphs
* temporal belief engines
* autonomous agents
* memory decay
* sophisticated contradiction resolution
* OAuth
* complex RBAC
* multi-user support
* plugin frameworks
* generalized workflow engines
* distributed event buses
* microservices
* Kubernetes
* speculative caching layers
* generic abstraction frameworks
* elaborate event taxonomies

When tempted to add something, ask:

Is this necessary to prove cross-client persistent memory?

If not:

Not v0.1.

⸻

10. Avoid Premature Abstraction

Do not create an interface merely because there is one implementation today.

Create abstractions where there is a demonstrated boundary.

Good examples:

EmbeddingProvider
ConsolidationProvider
MemoryRepository

These represent real replaceable components or architectural boundaries.

Bad examples:

AbstractMemoryEntityFactoryStrategy
GenericInteractionProcessorManager
BaseGremlinService<T,U,V>

Prefer boring code.

Boring code is easy to understand, test and replace.

⸻

11. Do Not Build Microservices

Gremlin v0.1 is a modular application, not a distributed system.

Logical boundaries matter.

Network boundaries do not automatically follow.

Prime and Worker may initially execute in the same Node.js process.

Shared packages may be used where they remove actual duplication.

Do not introduce network communication between components without a concrete requirement.

⸻

12. Prefer Vertical Slices

Implement working behavior end-to-end where practical.

Prefer:

request
  ↓
validation
  ↓
application logic
  ↓
persistence
  ↓
test

over creating large amounts of disconnected infrastructure for hypothetical future functionality.

A small working path is more valuable than a comprehensive unused framework.

⸻

13. Database Changes Require Care

Database migrations are part of the product.

Never modify an already-applied migration to change database history.

Create a new migration.

Schema changes affecting canonical source data require particular scrutiny.

Before destructive schema operations, verify whether source information could be lost.

Derived tables may be treated more aggressively because they are rebuildable.

⸻

14. Transactions

Use database transactions when multiple writes collectively represent one logical operation and partial completion would leave inconsistent state.

Do not wrap unrelated operations in transactions merely by habit.

Keep transaction scopes small.

External model/API calls should generally not occur while holding a database transaction open.

⸻

15. External Models Are Untrusted Dependencies

LLM output must be treated as untrusted structured input.

Validate model-generated data before persistence.

Use schemas for consolidation output.

Reject malformed results.

Do not allow model output to directly determine:

* authorization
* principal identity
* executable code
* database queries
* arbitrary namespaces
* privileged operations

Models propose interpretations.

Gremlin validates and stores them.

⸻

16. Validate at Boundaries

Use Zod or the project’s established validation mechanism at external boundaries.

Validate:

* HTTP input
* MCP tool input
* configuration
* external API responses where appropriate
* LLM structured output

Do not scatter redundant validation throughout trusted internal code.

Validate once at the boundary and maintain typed invariants internally.

⸻

17. TypeScript Rules

Use strict TypeScript.

Avoid any.

If unknown enters the system, narrow it explicitly.

Prefer descriptive domain types over primitive ambiguity.

Prefer:

conversationId
sourcePrincipal
embeddingModel
memoryNamespace

over:

id2
source
model
ns

Optimize for the developer reading the code six months later.

⸻

18. Error Handling

Errors must be actionable.

Do not swallow failures.

In particular, failures involving interaction ingestion must be visible because silently losing historical data violates a core Gremlin guarantee.

Prefer explicit domain errors where they improve handling.

Do not create elaborate error hierarchies without need.

Logs should provide enough context to diagnose failures without leaking secrets or private memory content unnecessarily.

⸻

19. Logging

Use structured logging.

Prefer metadata such as:

requestId
principal
conversationId
operation
duration
status

Avoid logging complete interaction or memory contents by default.

Never log credentials.

⸻

20. Testing Priorities

Tests should protect behavior and architectural boundaries rather than implementation details.

Highest-priority tests include:

Canonical history

* interactions persist correctly
* events persist correctly
* source provenance is preserved

Authorization

* principals can retrieve permitted namespaces
* principals cannot retrieve forbidden namespaces
* unauthorized information never appears in returned results

Consolidation

* source information can produce validated memories
* provenance links are retained
* malformed model output is rejected

Retrieval

* relevant memories can be found
* namespace filtering is applied during retrieval

Cross-client continuity

* Client A contributes information
* consolidation derives memory
* Client B retrieves it
* Client B does not require Client A’s raw conversation

⸻

21. Do Not Mock What Matters

Mocks are appropriate for:

* OpenRouter
* embedding providers
* external model APIs

Integration tests should use real PostgreSQL + pgvector where database behavior matters.

Do not replace important database semantics with mocks and then claim the persistence layer is tested.

⸻

22. Keep Commits Focused

Each change should have a clear purpose.

Avoid mixing:

* refactoring
* feature implementation
* formatting
* dependency upgrades
* unrelated cleanup

unless they are genuinely necessary for the same change.

Do not perform opportunistic repository-wide rewrites while implementing a small feature.

⸻

23. Dependency Discipline

Before adding a dependency, ask:

1. Does the platform or existing stack already solve this?
2. Is the dependency actively maintained?
3. Does it meaningfully reduce complexity?
4. Is its scope proportional to the problem?

Do not add large libraries for trivial utilities.

Do not replace established project dependencies without a concrete reason.

⸻

24. Comments

Comments should explain why, not narrate obvious code.

Good:

// Authorization must be included in the database query so forbidden
// memories never enter application-visible retrieval results.

Bad:

// Get the memories.
const memories = await getMemories();

Architectural decisions belong in documentation or ADRs when appropriate.

⸻

25. Refactoring

Refactor when it makes the current implementation clearer or safer.

Do not refactor toward hypothetical future requirements.

A little duplication is preferable to the wrong abstraction.

When the same meaningful pattern appears repeatedly, then consider extracting it.

⸻

26. Performance

Correctness first.

Measure before optimizing.

Likely performance-sensitive areas include:

* vector retrieval
* embedding generation
* consolidation
* context construction

Do not introduce caches, queues, batching frameworks or distributed infrastructure until measurements demonstrate a need.

Simple batching of embedding requests is acceptable where the provider naturally supports it.

⸻

27. Failure Modes Should Be Explicit

Gremlin interacts with unreliable external systems.

Design intentionally for:

OpenRouter unavailable
embedding provider unavailable
consolidation model returns invalid output
database unavailable
memory ingestion fails
memory retrieval fails

Do not silently convert infrastructure failures into successful empty results when doing so changes meaning.

For example:

"No relevant memories exist"

and:

"Memory service could not be reached"

are fundamentally different states.

Preserve that distinction.

⸻

28. Agent Autonomy

Agents are expected to make ordinary implementation decisions independently.

Do not request approval for:

* variable names
* file names that follow existing conventions
* straightforward refactoring
* test structure
* routine implementation details
* obvious bug fixes

Do request clarification or surface the issue when:

* canonical source data could be lost
* authorization semantics would change
* an architectural invariant appears impossible to satisfy
* the canonical specification is contradictory
* a decision would materially expand v0.1 scope
* a destructive operation is required
* multiple choices have significant long-term architectural consequences

Use judgment.

The goal is not maximum autonomy.

The goal is useful autonomy.

⸻

29. When Something Is Unclear

Use this order:

1. Read the canonical spec.
2. Read existing code and tests.
3. Follow established repository patterns.
4. Choose the smallest reversible implementation.
5. Ask only if the remaining ambiguity materially matters.

Do not invent elaborate architecture to avoid asking one important question.

Do not ask unnecessary questions to avoid making ordinary engineering decisions.

⸻

30. Definition of a Good Change

A good Gremlin change should generally be:

* small enough to understand
* complete enough to use
* typed
* validated at its boundaries
* tested appropriately
* secure by construction
* observable when it fails
* consistent with the canonical specification
* no more abstract than necessary

After completing a change, ask:

Did this make Gremlin demonstrably closer to satisfying the v0.1 acceptance test?

If not, reconsider whether the work belongs in v0.1.

⸻

31. Final Rule

Gremlin will eventually contain years of irreplaceable personal history.

Treat that fact seriously from the first commit.

But remember:

We are building v0.1, not designing the final form of Gremlin Prime.

No YOLO.

YAGNI.

Preserve the history.

Prove the architecture.

Then iterate.
