# M8 runbook — v0.1 release closure

This runbook closes Gremlin Prime v0.1 against the locked specification. Run
it from the deployed repository root after the M8 image has been built. Record
sanitized results in `docs/handoffs/M8.md`; never commit credentials, private
source content, internal endpoints, or backup artifacts.

## 1. Repository verification

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Run the PostgreSQL integration suite against a migrated disposable database:

```bash
DATABASE_URL=postgres://gremlin:password@localhost:5432/gremlin_test pnpm migrate
DATABASE_URL=postgres://gremlin:password@localhost:5432/gremlin_test \
  pnpm --filter @gremlin/prime test:integration
```

The authorization suite must prove that exact and descendant grants do not
match unrelated namespaces or prefix siblings such as `projects-secret`.
Search, direct retrieval, and timeline responses must contain no forbidden
memory content.

## 2. Export canonical source history

Create a host directory that is private to the operator, then run the export
container as the host user so the mounted files remain readable without
changing ownership:

```bash
umask 077
mkdir -p exports
chmod 700 exports
docker compose run --rm --no-deps \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD/exports:/exports" \
  gremlin-prime \
  node apps/prime/dist/export-source.js \
  "/exports/gremlin-source-$(date -u +%Y%m%dT%H%M%SZ)"
```

Acceptance checks:

- the command reports interaction and event counts
- `interactions.jsonl` and `events.jsonl` exist with mode `0600`
- every non-empty line parses as one JSON object
- representative records retain their original ID, occurrence timestamp,
  storage timestamp, source principal, content, and metadata
- interaction records additionally retain conversation ID and role
- event records additionally retain event type
- the output contains no derived-memory records
- rerunning against the same target directory fails instead of overwriting it

Treat exports as private source history. Store them encrypted and do not place
them in Git.

## 3. Rotate an API key

The v0.1 principal model stores one active key hash, so rotation deliberately
has no grace period. Prepare access to the client's secret configuration before
running the command.

Capture the replacement in an owner-only temporary file:

```bash
umask 077
docker compose run --rm --no-deps gremlin-prime \
  node apps/prime/dist/rotate-principal-key.js agent:opencode \
  > opencode-api-key.new
```

Immediately move the value into the deployment secret, remove the temporary
file, and restart or reconnect the client. Verify:

1. the replacement authenticates successfully
2. the previous key returns HTTP `401`
3. existing namespace grants are unchanged
4. an authorized memory remains available
5. a known forbidden memory remains absent

If delivery of the replacement fails, run rotation again; the newly printed
key becomes the only valid key. Rotation does not reactivate an inactive
principal.

## 4. Back up PostgreSQL

Use PostgreSQL's custom archive format. It captures canonical and derived data,
principal configuration, provenance, and migration history. API-key hashes are
included, so the archive is sensitive even though plaintext keys are not.

```bash
umask 077
mkdir -p backups
backup_path="backups/gremlin-$(date -u +%Y%m%dT%H%M%SZ).dump"
counts_path="${backup_path}.counts"

docker compose exec -T postgres pg_dump \
  --username gremlin \
  --dbname gremlin \
  --format custom \
  --no-owner \
  --no-acl \
  > "$backup_path"

docker compose exec -T postgres psql \
  --username gremlin \
  --dbname gremlin \
  --tuples-only \
  --no-align \
  --command "SELECT json_build_object(
    'principals', (SELECT count(*) FROM principals),
    'interactions', (SELECT count(*) FROM interactions),
    'events', (SELECT count(*) FROM events),
    'memories', (SELECT count(*) FROM memories),
    'evidence', (SELECT count(*) FROM memory_evidence),
    'migrations', (SELECT count(*) FROM schema_migrations)
  );" \
  > "$counts_path"

docker compose exec -T postgres pg_restore --list < "$backup_path" > /dev/null
```

Move the archive and its count manifest to encrypted storage according to the
operator's retention policy.

## 5. Restore drill

Restore into a separately named empty database. Never test restoration over the
live database.

```bash
restore_database=gremlin_restore_m8

docker compose exec -T postgres createdb \
  --username gremlin \
  "$restore_database"

docker compose exec -T postgres pg_restore \
  --username gremlin \
  --dbname "$restore_database" \
  --no-owner \
  --no-acl \
  < "$backup_path"

docker compose run --rm --no-deps \
  --env DATABASE_URL="postgres://gremlin:${POSTGRES_PASSWORD:-gremlin-dev}@postgres:5432/$restore_database" \
  migrate
```

Generate and compare the restored count manifest:

```bash
restored_counts_path="${backup_path}.restored-counts"

docker compose exec -T postgres psql \
  --username gremlin \
  --dbname "$restore_database" \
  --tuples-only \
  --no-align \
  --command "SELECT json_build_object(
    'principals', (SELECT count(*) FROM principals),
    'interactions', (SELECT count(*) FROM interactions),
    'events', (SELECT count(*) FROM events),
    'memories', (SELECT count(*) FROM memories),
    'evidence', (SELECT count(*) FROM memory_evidence),
    'migrations', (SELECT count(*) FROM schema_migrations)
  );" \
  > "$restored_counts_path"

diff --unified "$counts_path" "$restored_counts_path"

docker compose exec -T postgres psql \
  --username gremlin \
  --dbname "$restore_database" \
  --command "SELECT count(*) AS orphaned_evidence
    FROM memory_evidence evidence
    LEFT JOIN memories memory ON memory.id = evidence.memory_id
    LEFT JOIN interactions interaction ON interaction.id = evidence.interaction_id
    WHERE memory.id IS NULL OR interaction.id IS NULL;"
```

Acceptance requires an empty `diff`, zero orphaned evidence rows, and successful
migration checksum verification. After recording sanitized evidence and only
after confirming the live database name is `gremlin`, remove the disposable
restore database:

```bash
docker compose exec -T postgres dropdb \
  --username gremlin \
  "$restore_database"
```

## 6. Release acceptance

- complete every item in `docs/audits/v0.1-definition-of-done.md`
- record the export counts, rotation result, isolation result, backup archive
  validation, restore count comparison, and integrity result without private
  data
- merge the M8 pull request only after CI and production acceptance pass
- tag the accepted `main` revision, not the feature branch

```bash
git switch main
git pull --ff-only
git tag --annotate v0.1.0 --message "Gremlin Prime v0.1.0 — The Hoarder"
git push origin v0.1.0
```
