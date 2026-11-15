// These alerts are status data for an authorized operator, not outbound messages.
export function operationsAlerts(input: Readonly<{
  providers: readonly { kind: string; status: string; observedAt: string }[];
  persistenceStatus: string;
  backlog: number;
  oldestUnresolvedAt: Date | null;
  lastSuccessAt: Date | null;
  oldestProcessingAt: Date | null;
}>, now = new Date()) {
  const alerts: Array<{ code: string; severity: "error" | "warning"; provider?: string; since?: string }> = [];
  for (const provider of input.providers) {
    if (provider.status !== "ok") alerts.push({
      code: provider.status === "authentication_failed" ? "provider_authentication_failed" : "provider_request_failed",
      severity: provider.status === "authentication_failed" ? "error" : "warning",
      provider: provider.kind, since: provider.observedAt
    });
  }
  if (input.persistenceStatus === "unavailable") alerts.push({ code: "provider_telemetry_unavailable", severity: "error" });
  const cutoff = now.getTime() - 30 * 60_000;
  const processingStalled = input.oldestProcessingAt !== null && input.oldestProcessingAt.getTime() <= cutoff;
  const backlogStalled = input.backlog > 0 && input.oldestUnresolvedAt !== null
    && input.oldestUnresolvedAt.getTime() <= cutoff
    && (input.lastSuccessAt === null || input.lastSuccessAt.getTime() <= cutoff);
  if (processingStalled || backlogStalled) alerts.push({ code: "consolidation_stalled", severity: "warning" });
  return alerts;
}
