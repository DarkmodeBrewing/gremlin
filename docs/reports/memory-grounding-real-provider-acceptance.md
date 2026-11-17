# Memory grounding real-provider acceptance — 2026-11-17

Result: **PASS** on application revision
`3d636ecf5fc8bfa9990792a09c6661c2b71b965c`.

## Environment and scope

Ran synthetic conversations in a fresh PostgreSQL/pgvector database backed by
tmpfs, on a separate Docker network with no production mounts or published
ports. Used the same configured models as production:

- Consolidation and Chat: `~deepseek/deepseek-pro-latest` (configured alias).
- Embeddings: `openai/text-embedding-3-small`.

Existing provider credentials were injected privately into ephemeral test
containers. Only synthetic content went to the models. No production data,
permissions, configuration or containers were changed. No merge was performed.
The model alias can resolve differently later; this is a bounded acceptance
record rather than a guarantee of future model behavior.

## Final acceptance results

The complete final run made **19 provider requests**, all HTTP 200, and completed
16 checkpoints. It used the real extraction, embedding and streaming Chat
clients, real database persistence, authenticated Prime routes and the Chat
memory-context builder. The browser UI was not part of this acceptance.

| Case | Observed result |
|---|---|
| First cat, then second cat and parent relationship | Both facts persisted under `user/*`; authenticated Chat retrieval returned the second-cat relationship. |
| Fresh Chat answer about the second cat | Correctly identified Pip as Ada's son using retrieved context. |
| Named ale followed later by “two bottles of that vintage” | Retained Brewery Reserve Ale 2030 and the bottle count; evidence linked both the original named-beer source and follow-up assertion. |
| Fresh Chat answer about cellar contents | Correctly answered two bottles of Brewery Reserve Ale 2030; did not convert it to wine. |
| Other principal asks about Chat facts | No Chat memories returned. |
| Recall question plus incorrect assistant wine answer | Zero new memories. |
| Assistant-only invented vineyard answer | Zero new memories and zero consolidation-provider requests. |
| Standalone ambiguous “two bottles of the 2030 vintage” | Zero memories; no invented beverage. |
| Exact OpenCode grant and project fact | Stored at exact `project/gremlin-chat`, retrievable by OpenCode; its codeword was excluded from Chat results. |

Nine synthetic source records remained archived. The final source snapshot
SHA-256 was `2c4f4679bdfed4b9ab68c9e45581f6066467cdfb695825751070fdb51f069bb1`.
This is a final snapshot, not a claimed before/after fingerprint comparison.
Regression suites separately cover canonical preservation and provenance.

## Namespace configuration review

Read-only production inventory found three canonical source principals. The
following destination plan covers them without changing read grants:

```json
{
  "client:gremlin-chat": "user",
  "agent:opencode": {
    "namespace": "project/gremlin-chat",
    "includeDescendants": false
  },
  "agent:m10-acceptance": {
    "namespace": "acceptance/m10",
    "includeDescendants": false
  }
}
```

Chat already reads descendants of `user`. OpenCode already has an exact
`project/gremlin-chat` grant. The historical acceptance principal has no read
grants; its proposed destination has no matching grants in the reviewed policy
inventory. This is a proposed deployment map, not applied configuration. Verify
the inventory again at deployment. New source principals require an explicit
reviewed destination. Unknown principals fail closed before paid consolidation.

The review found that the original root-only implementation did not accommodate
OpenCode's exact grant reliably. Added an exact destination mode and tested it
with both mocked-provider regression tests and a real-model extraction/retrieval
case, preserving existing authorization semantics.

## Validation and execution history

Final code passed typecheck, build, **68 unit tests**, **57 real PostgreSQL/pgvector
integration tests**, Compose configuration and whitespace checks. Final GitHub
checks must pass on the PR's documentation revision before merge.

The initial live run completed the semantic cases but its last verification SQL
had an ambiguous `content` column. Corrected the harness and resumed the remaining
assertions against retained disposable data, without repeating completed calls.
That resume also passed the exact-namespace case. Then reran the complete suite
in fresh storage on the final application revision: PASS, no harness errors.

Across all acceptance attempts: 38 provider requests, all HTTP 200. Recorded
Prime consolidation/embedding cost was **0.047377593 OpenRouter credits** in
isolated telemetry. This is partial: four streaming Chat generations are not
included in that cost sum. The final complete run alone recorded 0.020826365
Prime credits. None of these records entered production telemetry or memory.

## Remaining boundary

This closes the controlled real-provider and namespace-review gates for PR #22.
It does not claim semantic infallibility or repair existing incorrect/unreadable
production projections. Deployment requires the explicit destination map;
selective production repair still needs its protected backup, reviewed evidence
sets, append-only lifecycle changes and post-repair Chat verification. No broad
rebuild is prescribed.
