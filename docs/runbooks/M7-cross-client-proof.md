# M7 runbook — Cross-client memory continuity

## Purpose

Prove the locked v0.1 hypothesis with two actual clients and two model
configurations:

1. Gremlin Chat / Model A contributes novel information.
2. Gremlin Prime archives and consolidates it.
3. A fresh OpenCode / Model B session receives no Client A transcript.
4. OpenCode retrieves only authorized derived memory through MCP.
5. Model B answers correctly from that memory.

Passing M6 protocol tests or naming an inspector principal
`agent:opencode` does not satisfy this proof. OpenCode itself must select and
invoke the Gremlin MCP tools.

## Security boundary

- OpenCode authenticates as its own Gremlin principal.
- The API key is supplied through `GREMLIN_MCP_API_KEY`; it is never committed.
- The MCP URL is supplied through `GREMLIN_MCP_URL`.
- Gremlin Prime constrains memory namespaces before returning results.
- OpenCode receives derived memory, not Client A's raw conversation.
- OAuth auto-detection is disabled because v0.1 uses API keys.
- The checked-in OpenCode configuration disables session sharing.
- Gremlin does not start OpenCode, manage its container, or access Docker.

## Provision Client B

Use the existing `agent:opencode` principal created for M6 if its one-time key
was retained. Otherwise create a fresh dedicated principal name and retain the
printed key in the deployment's secret storage:

```bash
docker compose run --rm gremlin-prime \
  node apps/prime/dist/create-principal.js agent:opencode
```

Grant only the namespaces required by the test. The canonical project-memory
example is:

```bash
docker compose run --rm gremlin-prime \
  node apps/prime/dist/grant-memory-read.js \
  agent:opencode "projects/gremlin/*"
```

Do not grant the namespace selected for the negative authorization check.

## Configure OpenCode

From the repository root, export values appropriate to the OpenCode runtime.
The URL must be reachable from that runtime; for a container attached to the
Gremlin Compose network it may be the internal Prime address.

```bash
export GREMLIN_MCP_URL=http://gremlin-prime:3000/mcp
export GREMLIN_MCP_API_KEY=grm_generated_value
export OPENCODE_CONFIG=clients/opencode/opencode.json
```

Do not put the API key in `opencode.json`, a prompt, a transcript, or a shell
command committed to the repository.

Confirm that OpenCode loaded the remote server:

```bash
opencode mcp list
```

The `gremlin` server must connect successfully and expose these five tools:

- `memory.search`
- `memory.get`
- `memory.timeline`
- `interaction.append`
- `event.emit`

## Execute the proof

### 1. Introduce a novel fact through Client A

In Gremlin Chat, state a unique project fact that is not present in the
repository, existing memories, or prior conversations. Record:

- Client A model
- conversation ID
- user-interaction ID
- exact timestamp

Do not commit the fact or its answer before Client B is tested.

### 2. Verify canonical archive and consolidate

Verify the interaction is stored with
`source_principal = client:gremlin-chat`. Run the existing explicit
consolidation endpoint, then verify:

- at least one derived memory captures the novel fact
- the memory is in an expected namespace
- `memory_evidence` links it to the Client A interaction
- the generating model and timestamp are recorded

### 3. Start an isolated Client B

Use a new OpenCode session and a model different from Model A. Do not paste,
import, attach, summarize, or otherwise provide the Client A conversation to
OpenCode.

Start OpenCode with the M7 configuration:

```bash
OPENCODE_CONFIG=clients/opencode/opencode.json opencode
```

Run the checked-in command with a question that requires the novel fact:

```text
/gremlin-recall <question requiring the novel fact>
```

Approve only the Gremlin read tool calls needed by the proof.

### 4. Verify the result

Capture evidence that:

- OpenCode invoked `gremlin_memory.search`
- any subsequent `gremlin_memory.get` used an ID returned by Gremlin
- the returned memory belonged to an authorized namespace
- Model B answered correctly
- the answer identified the memory ID used
- no Client A transcript was supplied to Client B

### 5. Verify namespace isolation

Ask OpenCode to search for a known memory in a namespace that
`agent:opencode` cannot read. Gremlin must return no forbidden memory. Do not
temporarily broaden the principal's grants to make the test easier.

## Acceptance record

Record the following in `docs/handoffs/M7.md` after the production run:

| Evidence | Required value |
| --- | --- |
| Client A and model | Actual client/model |
| Source interaction | Interaction ID and source principal |
| Consolidation | Run ID |
| Derived memory | Memory ID, namespace, and evidence link |
| Client B and model | OpenCode version and actual model |
| MCP retrieval | Tool call and authorized memory ID |
| Isolation | Forbidden namespace tested and empty result |
| Answer | Correct without Client A transcript |

Do not record API keys, authorization headers, raw private memory content, or
provider credentials.

## Completion criteria

M7 passes only when the production proof succeeds end to end. Repository
configuration and automated MCP integration tests are necessary support, but
are not substitutes for the actual OpenCode/model execution.
