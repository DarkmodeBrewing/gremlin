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
- sensitive metadata rejection
- real PostgreSQL integration tests

## Run locally

Requirements: Docker with Compose support.

```bash
cp .env.example .env
docker compose up --build
```

Gremlin Prime is then available at `http://localhost:3000`. Its health endpoint returns HTTP 200 when PostgreSQL is reachable and HTTP 503 when the dependency is unavailable.

Create an interaction-ingesting principal and capture the API key printed to standard output:

```bash
docker compose run --rm gremlin-prime \
  node apps/prime/dist/create-principal.js client:gremlin-chat
```

The key is shown once. Store it in a secret manager; only its SHA-256 hash is persisted.

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

## Repository layout

```text
apps/prime/  Gremlin Prime HTTP application and migration runner
migrations/  Append-only SQL migrations
docs/        Canonical specifications
```

Additional applications and shared packages will be introduced only when their milestone requires them.
