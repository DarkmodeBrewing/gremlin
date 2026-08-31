# Gremlin

Gremlin is user-owned persistence and memory infrastructure for AI systems.

The locked v0.1 scope is defined in [docs/v0.1_spec.md](docs/v0.1_spec.md). Contributor rules are defined in [AGENTS.md](AGENTS.md).

## Current milestone

M1 — Infrastructure:

- pnpm TypeScript monorepo
- Gremlin Prime Fastify application
- PostgreSQL 18 with pgvector
- immutable, checksummed SQL migrations
- dependency-aware `GET /health`
- Docker Compose deployment

## Run locally

Requirements: Docker with Compose support.

```bash
cp .env.example .env
docker compose up --build
```

Gremlin Prime is then available at `http://localhost:3000`. Its health endpoint returns HTTP 200 when PostgreSQL is reachable and HTTP 503 when the dependency is unavailable.

## Development

Requirements: Node.js 24+ and pnpm 11.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
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
