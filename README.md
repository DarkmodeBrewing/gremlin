# Gremlin

Gremlin is user-owned persistence and memory infrastructure for AI systems.

The locked v0.1 scope is defined in [docs/v0.1_spec.md](docs/v0.1_spec.md). Contributor rules are defined in [AGENTS.md](AGENTS.md).

## Implemented milestones

M1 — Infrastructure:

- pnpm TypeScript monorepo
- Gremlin Prime Fastify application
- PostgreSQL 18 with pgvector
- immutable, checksummed SQL migrations
- dependency-aware `GET /health`
- Docker Compose deployment

M2 — Interaction archive:

- registered principals with hashed API keys
- server-side interaction-ingestion permission
- append-only interaction storage with source provenance
- authenticated `POST /interactions`
- source-principal-constrained `GET /interactions/:id`
- API-wide per-IP rate limiting before authentication and database work
- sensitive metadata rejection
- real PostgreSQL integration tests

M3 — Gremlin Chat:

- deliberately basic single-conversation browser UI
- separate Fastify backend-for-frontend
- configurable OpenRouter model with streamed responses
- stable browser-local conversation UUID and transcript
- server-side Gremlin Prime and OpenRouter credentials
- user and assistant interaction ingestion with visible persistence state
- incomplete assistant-response archival when a stream fails after emitting text
- rate-limited, size-bounded chat requests

M4 — Consolidation:

- explicit, separately authorized `POST /admin/consolidate`
- bounded unprocessed-interaction claims without mutating raw history
- schema-constrained and runtime-validated memory extraction
- complete interaction evidence for every derived memory
- abstracted consolidation and embedding providers with OpenRouter implementations
- pgvector memory storage with recorded embedding model and dimensions
- visible failed runs whose source interactions remain retryable

M5 — Retrieval:

- explicit exact or hierarchical namespace-read policies per principal
- authenticated `POST /memory/search` using the recorded embedding model
- authenticated, authorization-constrained `GET /memory/:id`
- namespace filtering inside the Prime database query
- bounded Gremlin Chat retrieval using the latest user message
- clearly delimited, untrusted memory context injection before OpenRouter
- visible memory-retrieval failure without losing the archived user interaction

M6 — MCP:

- authenticated Streamable HTTP MCP endpoint at `POST /mcp`
- session ownership bound to the authenticated principal
- `memory.search`, `memory.get`, and authorized chronological `memory.timeline`
- `interaction.append` using the shared append-only interaction service
- append-only event storage with REST and MCP ingestion
- separately authorized `event.emit`
- identical server-side namespace filtering for REST and MCP memory access

M7 — Cross-client proof:

- checked-in OpenCode remote-MCP configuration with externalized credentials
- read-only `/gremlin-recall` proof command
- vertical PostgreSQL coverage from Client A ingestion through Client B MCP retrieval
- production proof using Gremlin Chat / DeepSeek and OpenCode / Claude Sonnet
- successful recall without sharing Client A's conversation history
- production verification that authorized memory is returned and forbidden memory is excluded
- post-v0.1 direction recorded in [docs/roadmap.md](docs/roadmap.md)

M8 — v0.1 release closure:

- canonical JSONL source export with overwrite protection
- principal API-key rotation with immediate old-key revocation
- production backup and independent restore procedure
- accepted and tagged `v0.1.0 — The Hoarder`

M9 — Background consolidation:

- opt-in in-process worker without a separate queue or scheduler service
- chronological interaction and event batches with typed evidence
- bounded automatic retries, visible failures, and interrupted-run recovery
- authorized run inspection while retaining the manual trigger

## Run locally

Requirements: Docker with Compose support.

Copy the local configuration and start PostgreSQL plus migrations first:

```bash
cp .env.example .env
docker compose up --build --detach postgres migrate
```

Create Gremlin Chat's interaction-ingesting principal and capture the API key printed to standard output:

```bash
docker compose run --rm gremlin-prime \
  node apps/prime/dist/create-principal.js client:gremlin-chat
```

The key is shown once. Store it in a secret manager; only its SHA-256 hash is persisted.

Set the generated key, a dedicated OpenRouter API key with an appropriate credit limit, and an explicit OpenRouter model slug in `.env`:

```dotenv
GREMLIN_CHAT_API_KEY=grm_generated_value
OPENROUTER_API_KEY=sk-or-generated-value
DEFAULT_CHAT_MODEL=provider/model
CONSOLIDATION_MODEL=provider/model
EMBEDDING_MODEL=provider/embedding-model
```

Then start the complete stack:

```bash
docker compose up --build --detach
```

Gremlin Prime is available at `http://localhost:3000`. Its health endpoint
returns HTTP 200 when PostgreSQL is reachable and HTTP 503 when the dependency
is unavailable.

Gremlin Chat is available at `http://localhost:3001`. Its host port binds to loopback by default; use an authenticated reverse proxy or another trusted access layer before exposing it to a network.

Append and retrieve an interaction:

```bash
curl --request POST http://localhost:3000/interactions \
  --header "Authorization: Bearer $GREMLIN_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{
    "conversationId": "018f4f7e-8c3a-7a61-8f55-3d6e7614f289",
    "timestamp": "2026-08-31T20:00:00Z",
    "role": "user",
    "content": "Gremlin now archives interactions.",
    "metadata": { "client": "example" }
  }'

curl http://localhost:3000/interactions/INTERACTION_ID \
  --header "Authorization: Bearer $GREMLIN_API_KEY"
```

An authenticated principal can retrieve only interactions it submitted. Requests cannot supply or override `sourcePrincipal`.

Create the separately authorized consolidator principal and store its one-time API key:

```bash
docker compose run --rm gremlin-prime \
  node apps/prime/dist/create-principal.js system:consolidator --can-consolidate
```

Run one bounded consolidation batch explicitly:

```bash
curl --request POST http://localhost:3000/admin/consolidate \
  --header "Authorization: Bearer $GREMLIN_CONSOLIDATOR_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{}'
```

For automatic consolidation, keep the same active `system:consolidator`
principal with `can_consolidate`, then set:

```dotenv
BACKGROUND_CONSOLIDATION_ENABLED=true
CONSOLIDATION_PRINCIPAL_ID=system:consolidator
CONSOLIDATION_POLL_INTERVAL_MS=60000
CONSOLIDATION_RETRY_DELAY_MS=300000
CONSOLIDATION_MAX_ATTEMPTS=3
```

Prime recovers interrupted runs at startup. The in-process worker schedules its
next poll only after the current poll completes, records no run when the queue
is empty, and stops automatically retrying a source after the configured
attempt limit. An authorized operator can inspect recent work with
`GET /admin/consolidation/runs?limit=20` and can still use the manual endpoint
to retry a source deliberately.

A successful response reports the run ID and source/memory counts. Provider,
embedding, validation, or persistence failure returns a visible failed run
(`502` for an external provider stage, `500` for persistence). A failed run does
not mark its source interactions as successfully processed, so a later manual
request can retry them.

Grant Gremlin Chat only the namespaces it may read. A plain namespace is an
exact grant; a `/*` suffix includes that namespace and all descendants:

```bash
docker compose run --rm gremlin-prime \
  node apps/prime/dist/grant-memory-read.js \
  client:gremlin-chat identity preferences "user/*" "programming/*" "projects/*" "brewing/*"
```

Search authorized memory directly:

```bash
curl --request POST http://localhost:3000/memory/search \
  --header "Authorization: Bearer $GREMLIN_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"query":"Do you know my cat?","limit":5}'
```

Prime applies namespace authorization in the database query. An unauthorized
memory is absent from search results, and direct retrieval conceals it with
HTTP 404.

Create a principal for an MCP client. Ordinary client and agent principals can
append interactions; event ingestion is granted explicitly:

```bash
docker compose run --rm gremlin-prime \
  node apps/prime/dist/create-principal.js \
  agent:opencode --can-ingest-events
```

Grant only the memory namespaces the client requires, then configure the MCP
client to use Streamable HTTP at `http://localhost:3000/mcp` with the generated
key as a Bearer token. Prime exposes:

- `memory.search`
- `memory.get`
- `memory.timeline`
- `interaction.append`
- `event.emit`

`memory.timeline` returns authorized memories in reverse chronological order;
it does not dereference raw evidence interactions belonging to other
principals. MCP sessions remain bound to the principal that initialized them.

## Operations

Export canonical interactions and events into a new directory containing
`interactions.jsonl` and `events.jsonl`:

```bash
DATABASE_URL=postgres://gremlin:password@localhost:5432/gremlin \
  pnpm source:export ./exports/gremlin-source-$(date -u +%Y%m%dT%H%M%SZ)
```

The export uses one repeatable-read snapshot, preserves source IDs and
provenance, writes files with owner-only permissions, and refuses to overwrite
an existing directory. It intentionally excludes derived memories.

Rotate an active principal's API key:

```bash
DATABASE_URL=postgres://gremlin:password@localhost:5432/gremlin \
  pnpm principal:rotate-key agent:opencode
```

The replacement is printed once. The old key becomes invalid immediately, so
update the client's secret before reconnecting. Prime stores only the new
SHA-256 hash.

The complete production procedures for containerized export, credential
rotation, PostgreSQL backup/restore, integrity checks, and v0.1 release
acceptance are in
[docs/runbooks/M8-release-closure.md](docs/runbooks/M8-release-closure.md).

## Development

Requirements: Node.js 24+ and pnpm 11.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The PostgreSQL integration suite additionally requires a migrated test database:

```bash
DATABASE_URL=postgres://gremlin:password@localhost:5432/gremlin pnpm migrate
DATABASE_URL=postgres://gremlin:password@localhost:5432/gremlin \
  pnpm --filter @gremlin/prime test:integration
```

With PostgreSQL available through `DATABASE_URL`:

```bash
pnpm migrate
pnpm dev
```

Local development additionally requires `GREMLIN_CHAT_API_KEY`,
`OPENROUTER_API_KEY`, `DEFAULT_CHAT_MODEL`, `CONSOLIDATION_MODEL`, and
`EMBEDDING_MODEL`. `GREMLIN_PRIME_URL`, `MEMORY_SEARCH_LIMIT`, and
`MEMORY_CONTEXT_MAX_TOKENS` remain optional for Gremlin Chat.

## Repository layout

```text
apps/prime/  Gremlin Prime HTTP application and migration runner
apps/chat/   Gremlin Chat browser UI and backend
migrations/  Append-only SQL migrations
docs/        Canonical specifications
```

Additional applications and shared packages will be introduced only when their milestone requires them.
