# Adaptive model routing (directional M12 proposal)

**Status:** Proposal only; no implementation commitment. M12 remains a declarative client/agent profile milestone. Validate provider features, pricing, residency, and response metadata against current documentation before implementation.

## Problem and objective

Gremlin should choose an appropriate model/provider execution profile for a task without routinely defaulting to the cheapest or most capable model. Optimize **cost per successfully completed task**, not merely price per token. Preserve explicit user/mission overrides and predictable behavior for reproducible operations.

This proposal extends M12's model/provider policy. It is distinct from [cost-aware mission scheduling](cost-aware-mission-scheduling.md), which chooses *when* deferred work should execute; routing chooses *how and where* eligible work executes.

## Declarative policy

A client or agent profile may specify:

- Routing mode: explicit model, fixed profile, or automatic.
- Named profiles (initial candidates: Economy, Balanced, Advanced) with eligible providers/models, capability constraints, reasoning-effort options where supported, context/output limits, and fallback behavior.
- Maximum per-task and per-mission spend, latency expectations, privacy/data-residency requirements, and tool/permission constraints.
- Manual overrides at task and mission level, including a fixed model for deterministic evaluation or reconstruction.
- Escalation thresholds and maximum retries. A model change must never silently grant additional tool permissions.

Risk and complexity are separate. High-risk operations require safeguards such as approval, dry runs, and tests; they do not automatically require the most expensive model.

## First experiment: OpenRouter-managed routing

Evaluate OpenRouter's available automatic model-selection endpoint(s) as a **replaceable routing backend**, not a permanent architectural dependency. Confirm the exact API identifiers, availability, routing fees, model-selection semantics, region support, usage reporting, and actual selected-model metadata before implementation. Do not assume automatic routing is free or available in EU-only regions without verifying current terms.

Keep explicit provider/model routing for embeddings, memory reconstruction, acceptance tests, and other reproducible operations. Gremlin retains authorization, policy enforcement, spend limits, routing-event provenance, and manual override authority regardless of backend.

## Routing decision and feedback

Record, without prompt text or credentials:

- Task/mission identifier, policy revision, routing mode, selected profile, and permitted candidates.
- Chosen provider/model when reported, reasoning effort when supported, and any fallback or escalation.
- Decision rationale/available classification signals, confidence or uncertainty only when actually measured (do not fabricate probability scores).
- Estimated versus reported tokens and cost, latency, retry count, validation results, and task outcome; distinguish unknown from zero.
- Source and timestamp of pricing and model-capability metadata.

Reuse existing provider usage/history mechanisms where appropriate, but avoid treating partial Prime accounting as an account-wide bill. Respect canonical event provenance and principal-based access controls.

## Smallest useful vertical slice

1. Define and validate the routing policy schema with a manual override and explicit-model fallback; no execution orchestration in Prime.
2. Add one optional automatic routing adapter for a bounded, low-risk Gremlin Chat workload.
3. Observe the selected model, reported usage/cost, failure behavior, and residency constraints in real provider responses.
4. Compare against a fixed Balanced baseline on a representative, repeatable task set.
5. Expand to agent workloads only after outcome quality, spend ceilings, permissions, and escalation are demonstrably reliable.

**Acceptance evidence:** Show successful manual override, policy rejection of an ineligible model, safe fallback on routing failure, no paid retry caused by telemetry persistence failure, observable unknown-cost handling, and a measured comparison of successful-task cost and quality against fixed Balanced. Record the outcome even if auto-routing does not outperform the baseline.

## Future options, not prerequisites

A Gremlin-owned deterministic classifier or lightweight model-based classifier may replace or supplement external routing later. Evaluate complexity, risk, and uncertainty separately; use Balanced when classification is inconclusive. Avoid frequent model switching within an active task unless new evidence justifies escalation and its context/cache costs. Any self-optimizing router must be calibrated using real execution outcomes, not assumed classifier confidence.

## Boundaries and sequencing

M12 describes policy/contracts first. Actual dispatch belongs to the relevant client or external Agent Runner; Gremlin Prime does not orchestrate containers or access Docker. Persistent Mission policy integration follows M14's durable state foundation. Scheduling discounted provider windows remains a separate later slice. Do not let this proposal displace M11 closeout or the planned memory-fidelity investigation.
