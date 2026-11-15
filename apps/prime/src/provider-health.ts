type ProviderKind = "consolidation" | "embedding";
type Observation = Readonly<{
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
export function createProviderHealth(fetchImplementation: typeof fetch = fetch) {
  const observations: Record<ProviderKind, Observation> = {
    consolidation: initial(), embedding: initial()
  };
  function record(kind: ProviderKind, httpStatus: number | null): void {
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
  }
  return {
    observe(kind: ProviderKind): typeof fetch {
      return async (input, init) => {
        try {
          const response = await fetchImplementation(input, init);
          record(kind, response.status);
          return response;
        } catch (error: unknown) {
          record(kind, null);
          throw error;
        }
      };
    },
    snapshot() {
      return { consolidation: { ...observations.consolidation }, embedding: { ...observations.embedding } };
    }
  };
}

export type ProviderHealth = ReturnType<typeof createProviderHealth>;
