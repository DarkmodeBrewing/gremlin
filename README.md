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

## Run locally

Requirements: Docker with Compose support.

Copy the local configuration and start the persistence services first:

```bash
cp .env.example .env
docker compose up --build --detach postgres migrate gremlin-prime
```

Gremlin Prime is available at `http://localhost:3000`. Its health endpoint returns HTTP 200 when PostgreSQL is reachable and HTTP 503 when the dependency is unavailable.

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
```

Then start the complete stack:

```bash
docker compose up --build --detach
```

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

Local Gremlin Chat development additionally requires `GREMLIN_CHAT_API_KEY`, `OPENROUTER_API_KEY`, `DEFAULT_CHAT_MODEL`, and optionally `GREMLIN_PRIME_URL` in the process environment.

## Repository layout

```text
apps/prime/  Gremlin Prime HTTP application and migration runner
apps/chat/   Gremlin Chat browser UI and backend
migrations/  Append-only SQL migrations
docs/        Canonical specifications
```

Additional applications and shared packages will be introduced only when their milestone requires them.
