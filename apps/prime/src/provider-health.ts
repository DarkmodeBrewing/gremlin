export type ProviderKind = "consolidation" | "embedding";
export type Observation = Readonly<{
  status: "not_observed" | "ok" | "authentication_failed" | "rate_limited" | "unavailable" | "request_failed";
  observedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  httpStatus: number | null;
}>;

const initial = (): Observation => ({
  status: "not_observed", observedAt: null, lastSuccessAt: null,
  lastFailureAt: null, httpStatus: null
});

// Observe existing requests only: polling status must not spend provider credit.
// Store fixed classifications, never headers, URLs, request bodies or error text.
export function createProviderHealth(fetchImplementation: typeof fetch = fetch,
  persist?: (kind: ProviderKind, observation: Observation) => Promise<void>
) {
  let persistenceStatus: "not_configured" | "not_observed" | "ok" | "unavailable" = persist ? "not_observed" : "not_configured";
  let persistenceFailureAt: string | null = null;
  const observations: Record<ProviderKind, Observation> = {
    consolidation: initial(), embedding: initial()
  };
  async function record(kind: ProviderKind, httpStatus: number | null): Promise<void> {
    const now = new Date().toISOString();
    const status: Observation["status"] = httpStatus === null ? "unavailable"
      : httpStatus >= 200 && httpStatus < 300 ? "ok"
      : httpStatus === 401 || httpStatus === 403 ? "authentication_failed"
      : httpStatus === 429 ? "rate_limited"
      : httpStatus >= 500 ? "unavailable" : "request_failed";
    observations[kind] = {
      status, observedAt: now, httpStatus,
      lastSuccessAt: status === "ok" ? now : observations[kind].lastSuccessAt,
      lastFailureAt: status === "ok" ? observations[kind].lastFailureAt : now
    };
    if (persist) {
      try {
        await persist(kind, observations[kind]);
        persistenceStatus = "ok";
      } catch {
        // A telemetry outage must not turn a paid successful request into a
        // retried provider call or mask the provider's original error.
        persistenceStatus = "unavailable";
        persistenceFailureAt = new Date().toISOString();
      }
    }
  }
  return {
    observe(kind: ProviderKind): typeof fetch {
      return async (input, init) => {
        try {
          const response = await fetchImplementation(input, init);
          await record(kind, response.status);
          return response;
        } catch (error: unknown) {
          await record(kind, null);
          throw error;
        }
      };
    },
    persistence() { return { status: persistenceStatus, lastFailureAt: persistenceFailureAt }; },
    snapshot() {
      return { consolidation: { ...observations.consolidation }, embedding: { ...observations.embedding } };
    }
  };
}

export type ProviderHealth = ReturnType<typeof createProviderHealth>;
