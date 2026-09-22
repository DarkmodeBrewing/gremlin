# M8 Production Acceptance Test Report

**Milestone:** M8 — v0.1 Release Closure  
**Project:** Gremlin Prime  
**Date:** 2026-09-22  
**Environment:** Production  
**Result:** PASS

## Summary

M8 production acceptance completed successfully. The milestone verified:

- repository build and automated tests
- PostgreSQL integration tests
- canonical source export and overwrite protection
- production principal API-key rotation and immediate old-key revocation
- preservation of namespace authorization across key rotation
- positive and negative memory-access behavior
- production PostgreSQL backup and independent restore
- restored row counts and evidence integrity

No production data was modified or lost during the backup/restore test.

## 1. Repository verification

The M8 branch was built and tested using Node.js 24 and pnpm 11.19.0 in a
disposable container environment.

| Check | Result |
| --- | --- |
| Dependency installation | PASS |
| Supply-chain policy | PASS |
| Prime typecheck | PASS |
| Chat typecheck | PASS |
| Prime unit tests | PASS — 22/22 |
| Chat unit tests | PASS — 15/15 |
| Prime build | PASS |
| Chat build | PASS |
| PostgreSQL integration files | PASS — 8/8 |
| PostgreSQL integration tests | PASS — 23/23 |
| Principal key-rotation integration tests | PASS — 2/2 |
| Namespace authorization tests | PASS |

## 2. Canonical source export

The production source exporter created independently readable canonical
history:

| File | Records | JSON validation |
| --- | ---: | --- |
| `interactions.jsonl` | 12 | PASS |
| `events.jsonl` | 1 | PASS |

Both files had owner-only permissions. The exporter was then invoked against
the existing destination and failed with `EEXIST`, leaving the original export
unchanged. The acceptance-test export was removed afterward because it
contained private canonical history and was no longer required.

Result: **PASS**

## 3. Production principal key rotation

The dedicated OpenCode principal was rotated using the M8 command. A fresh
OpenCode client connected successfully with the replacement credential. An MCP
initialization attempt using the previous credential returned HTTP `401`, with
no grace period in which both credentials remained valid.

The principal's existing namespace grant was unchanged. Rotation therefore
changed authentication material without changing authorization policy.

Result: **PASS**

## 4. Post-rotation namespace acceptance

A fresh OpenCode client using the replacement credential retrieved a known
authorized project memory and answered with evidence. A second request required
a known memory outside the principal's grants. Prime did not expose that
memory; the client received only unrelated authorized material and correctly
declined to answer without sufficient evidence.

This verified both server-side namespace isolation and evidence-aware client
behavior after key rotation.

Result: **PASS**

## 5. Production PostgreSQL backup

A 67 KiB custom-format PostgreSQL archive was created with mode `0600`.
`pg_restore --list` validated the archive successfully. The backup and its
count manifest were retained outside Git.

The production baseline was:

| Relation | Rows |
| --- | ---: |
| Principals | 3 |
| Interactions | 12 |
| Events | 1 |
| Memories | 3 |
| Evidence links | 4 |
| Migrations | 5 |

Result: **PASS**

## 6. Independent restore test

The production archive was restored into a separately named empty database;
the live database was never used as the restore target. Restored counts matched
the production manifest exactly:

| Relation | Production | Restored |
| --- | ---: | ---: |
| Principals | 3 | 3 |
| Interactions | 12 | 12 |
| Events | 1 | 1 |
| Memories | 3 | 3 |
| Evidence links | 4 | 4 |
| Migrations | 5 | 5 |

The restored database contained zero evidence rows referencing missing
memories or interactions. The temporary restore database was eligible for
removal after validation.

Result: **PASS**

## Acceptance matrix

| Requirement | Result |
| --- | --- |
| Dependency/install verification | PASS |
| Typecheck | PASS |
| Unit tests | PASS — 37/37 |
| Build | PASS |
| PostgreSQL integration tests | PASS — 23/23 |
| Canonical interactions export | PASS — 12 |
| Canonical events export | PASS — 1 |
| JSONL validation | PASS |
| Owner-only export permissions | PASS |
| Export overwrite protection | PASS |
| Production principal key rotation | PASS |
| New credential authentication | PASS |
| Old credential revocation | PASS — HTTP 401 |
| Authorization grants preserved | PASS |
| Authorized namespace retrieval | PASS |
| Forbidden namespace isolation | PASS |
| Unsupported answer refusal | PASS |
| Production database backup | PASS |
| Backup archive validation | PASS |
| Independent restore | PASS |
| Restored counts match production | PASS |
| Orphaned evidence check | PASS — 0 |

## Conclusion

M8 production acceptance is **PASS**.

Together with the previously accepted milestones, the functional and
operational requirements for Gremlin Prime v0.1 have been exercised
successfully in production.

**M8 status:** ACCEPTED  
**Release candidate:** `v0.1.0 — The Hoarder`
