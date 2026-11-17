# M11 Prime provider cost accounting

> Current status (2026-11-17): deployed and production verified. See the
> [bounded closeout](../reports/M11-closeout.md) for evidence, scope limits
> and the final PR #21 merge gate. Preparation notes below are historical;
> their pre-deployment statements no longer describe current deployment.

Depends on durable operations/migration 0010. Review after the normal-use
observation period. Not merged or deployed; migration 0011 must precede this
application version.

Prime's embedding and consolidation clients report validated cost/token fields
from already parsed successful HTTP responses. The protected operations endpoint
summarizes all-time and last-24-hour records with decimal-string reported-credit
sums, parsed/known/unknown cost counts and partial reported token totals. No
price estimates or additional provider requests are made.

Zero is reported zero; missing/invalid cost remains unknown. This is not an
account-wide bill: Chat's direct generation, other clients, historical traffic,
HTTP/transport errors, malformed JSON and telemetry losses are excluded.
Parsed responses later rejected for invalid model output can still carry billed
usage and are recorded. A persistence error changes the usage-telemetry status
and operator alert, not the original provider result; it never triggers a paid
retry. No message/source/response content, headers or credentials are stored.

Validation — 2026-11-15: frozen install, workspace typecheck/build, 60 unit tests
and 52 real PostgreSQL/pgvector integration tests passed. New checks cover
reported zero, invalid/absent fields, exact decimal sums, coverage/window
semantics, fresh recorder instances, invalid model output with reported usage,
embedding wiring, and a real read-only-database insertion failure preserving a
successful provider result. Tests used isolated storage/network and no production
credentials; test containers/network were removed.

CI for the stacked branch covers the resulting application. Main-targeted
checks such as CodeQL must also run when the PR is retargeted to main after the
durable-operations dependency merges. Keep this PR draft until then and review
its scope against actual usage observations before deployment.
