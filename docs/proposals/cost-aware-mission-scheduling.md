# Cost-aware mission scheduling (directional proposal)

**Status:** Future enhancement; not part of the committed v0.2 scope. Revisit after persistent missions, execution policies, and provider cost accounting exist.

Gremlin should eventually support **provider-agnostic, cost-aware scheduling** of deferred missions. Some model providers may offer off-peak rates, batch discounts, or other time-dependent pricing. Rather than hard-code a DeepSeek-specific timer, the Mission layer should decide *when and where* eligible work runs based on configurable provider pricing calendars and mission constraints. The external Agent Runner remains responsible for execution and isolation; the scheduler must not acquire Docker access.

The design should allow:

- Multiple independent and overlapping pricing schedules per provider/model, with effective dates, IANA time zones, daylight-saving transitions, holiday exceptions, and changing input/output/cached-token rates.
- Other discount mechanisms (e.g. asynchronous batch APIs) represented as execution options, not forced into clock-based windows.
- Mission policies for immediate versus deferrable execution, eligible models/providers, capabilities, deadlines, budgets, and estimated token usage.
- Selection of the cheapest *eligible* execution window before a deadline, while respecting authorization, model suitability, operational limits, and approved budget. Never delay interactive or urgent work solely for discounts; avoid indefinite starvation.
- Refreshable pricing metadata with source, timestamp, validity, and fallback behavior when prices are unknown or stale. Do not assume any provider's current discounts are permanent.
- Auditable scheduling decisions and actual per-mission token/cost accounting, so estimates can be compared with observed costs and task success.

**Example:** A background memory-consolidation mission may wait for a discounted provider window, while an interactive Gremlin Chat request runs immediately. An overnight repository-analysis mission can choose among multiple eligible windows but must finish before its deadline.

**Sequencing:** First establish durable missions/queues and execution policy, then provider cost accounting and runner dispatch. Add cost optimization as a separate, small vertical slice after those foundations are proven. This document records the idea, not an implementation commitment.
