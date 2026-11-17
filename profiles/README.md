# Declarative client profiles (M12.1–M12.2)

Profiles describe the current contract for Gremlin Chat and OpenCode. They are
operator-reviewed expectations, not a source of authorization. Prime's existing
principal and namespace tables remain authoritative. The profiles do not start
processes, apply permissions, generate credentials, or access Docker.

## Validate locally

```bash
pnpm profiles:validate
pnpm profiles:validate profiles/opencode.json
```

Paths are relative to the repository root, regardless of the caller's working
directory; absolute paths are also accepted. With no paths, both checked-in
profiles are validated. Each JSON document must be at most 64 KB; a collection
can contain at most 20 profiles. The strict Zod schema is in
`apps/prime/src/client-profiles.ts`.

Offline validation checks version/identity uniqueness, ordinary client/agent
identities, non-administrative capabilities, safe environment-variable references,
namespace syntax and complete destination readability. It rejects unknown fields,
embedded credentials, commands, duplicate policies/tools and inconsistent MCP
ingestion capabilities. There are no literal endpoint or credential-value fields.
Do not put secrets or private source content in any descriptive metadata.

For OpenCode, it also compares environment references, remote-server binding,
API-key authentication (OAuth disabled), session-sharing exclusion and interactive
tool permission against the checked-in `clients/opencode/opencode.json`. It does
not contact OpenCode, fetch an external schema or guarantee that an external
installation has loaded that file.

## Check deployed metadata without changing it

Provide `DATABASE_URL` and `CONSOLIDATION_NAMESPACE_ROOTS` through the existing
protected operator environment, then run:

```bash
pnpm profiles:check
```

The root mapping must come from the same configuration used by the target Prime
process. The checker cannot establish that an arbitrary caller-supplied mapping
is the running process's configuration. The DM01 acceptance procedure reads it
from the live container without printing secrets.

The check opens one repeatable-read, read-only transaction. It selects only
principal identity/activity/capability columns and the selected clients' read
policies. It does not select credential hashes, raw history, derived memory,
provider data or unrelated principal records. It compares:

- principal existence and activity;
- exact ingestion and administrative capability expectations;
- exact read-policy entries, including unexpected extra grants;
- the configured consolidation destination against the profile;
- whether the actual grants cover the entire configured destination.

An exact `project/gremlin-chat` grant covers an exact destination. It does not
cover a topic subtree beneath that namespace. Conversely, Chat's `user/*` grant
covers `user` and all descendant destinations, with segment-boundary matching.
This is the regression boundary learned from the memory correctness repair.

Results are JSON with `mode`, `result`, and per-profile stable issue codes.
Failures do not echo input values, connection strings, SQL errors or credentials.
Exit codes: 0 = PASS, 1 = metadata drift, 2 = invalid input/environment or check
unavailable. Nothing is automatically corrected or provisioned.

In a built Prime image, use `node apps/prime/dist/profiles.js validate` or `check`;
the reference profiles and checked-in adapter JSON are included in that image.
The CLI does not require the HTTP application to be started.

## Contract fields and limits

- `schemaVersion`: currently 1.
- `id`, `principalId`, `active`, `capabilities`: expected registered identity and
  permissions; no `system:` or consolidation-capable profiles in this slice.
- `memory.read`, `memory.destination`: explicit exact/subtree expectations.
  These initial profiles require a readable destination.
- `connection`: REST or MCP transport, environment-variable names for URL/key,
  and the existing OpenCode adapter-file/tool declaration when applicable.
- `model`: Chat's provider/model/key environment references, or client-managed
  model selection for OpenCode. These describe expectations; this checker does
  not resolve model references or enforce provider/model policy at runtime.
- `runtime`: external execution ownership, service/client kind and a declaration
  that Prime HTTP must be reachable. No connectivity probe or process launcher.
- `projectContext`: repository identity metadata, not an executed prompt.

The check covers selected profiles only. It is not a complete registry audit;
for example, the historical M10 acceptance principal is outside these two client
profiles. Runtime consumption, configuration generation, deployment automation,
model-policy enforcement and executable project context remain future slices.
