# Device-independent personal computing environment

Status: directional architectural principle (2026-10-14). This is a product vision, not an implementation milestone or change to the locked v0.1 specification.

> The user's computing environment is persistent and device-independent. Devices provide interfaces, execution environments provide capabilities, and Gremlin maintains continuity between them.

## Intent

Gremlin is not a universal operating system or desktop environment. It is a user-owned, persistent **personal computing control plane** operating across ordinary operating systems, devices, clients, models and execution hosts.

A user should be able to begin work on a desktop, inspect and approve it on a phone, and resume later on another machine without manually rebuilding the task context. The experience follows the user; the OS and hardware need not.

## Responsibilities and boundaries

- **Gremlin Prime:** Own canonical history, authorized memory and provenance; durable state such as Missions belongs to Gremlin's persistent services, not an ephemeral model session.
- **Missions (directional M14):** Own objectives, policies, approval requests, state transitions and continuity across executions.
- **Puck / Gremlin Chat / other clients:** Present device-appropriate views and user interactions. They may cache local UI state, but are not the authoritative owners of shared continuity.
- **Agent Runner and other execution environments:** Supply temporary capabilities and execution lifecycle. A container, process, model or host may disappear without destroying the Mission.
- **MCP and APIs:** Provide explicit, authenticated, authorized interfaces across components and external systems. Clients and models are replaceable.

Prime must not gain Docker-socket access or become a container orchestrator. Preserve existing namespace and principal authorization, append-only source history, provenance, and rebuildable derived state.

## Illustrative journey (not a committed feature)

1. On a desktop, the user opens a development Mission and requests a bounded change.
2. An external Runner starts a disposable agent execution and reports status and artifacts.
3. On a phone, Puck displays a pending pull-request approval with the relevant context and evidence.
4. The user authorizes the action; the Mission records the decision and resulting state.
5. Back at the desktop, the user resumes the same Mission, including decisions, artifacts and execution history, without transferring an entire desktop session.

Continuity means shared **intent, state, context and artifacts**; it does not require live process migration, identical UIs, universal app binaries, or synchronization of every file.

## Design tests for future slices

1. Can the user switch devices without losing authoritative Mission state?
2. Can a client, model or Runner be replaced without losing continuity?
3. Are approvals explicit, attributable and enforced at trusted boundaries?
4. Are source records preserved, derived state rebuildable and access server-authorized?
5. Does the smallest vertical slice demonstrate real cross-device continuation without creating a new OS or speculative infrastructure?

## Scope

This principle guides future Puck, Mission and Runner design. It does **not** authorize implementation work by itself. Promote specific capabilities through the roadmap's existing vertical-slice and scope-discipline process.

Related: [roadmap](../roadmap.md), [Mission and initiative design](initiative-and-healthkit.md), and [contributor architectural invariants](../../AGENTS.md).
