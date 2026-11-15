import { describe, expect, it } from "vitest";
import { operationsAlerts } from "../src/operations-alerts.js";

const now = new Date("2026-11-15T12:00:00Z");
const old = new Date("2026-11-15T11:00:00Z");
const fresh = new Date("2026-11-15T11:59:00Z");
const baseline = { providers: [], persistenceStatus: "ok", backlog: 0,
  oldestUnresolvedAt: null, lastSuccessAt: null, oldestProcessingAt: null };

describe("operator alerts", () => {
  it("does not treat missing provider activity or an idle worker as failure", () => {
    expect(operationsAlerts(baseline, now)).toEqual([]);
  });
  it("distinguishes unresolved provider authorization and telemetry failures", () => {
    expect(operationsAlerts({ ...baseline, persistenceStatus: "unavailable", providers: [
      { kind: "embedding", status: "authentication_failed", observedAt: old.toISOString() }
    ] }, now).map(a => a.code)).toEqual(["provider_authentication_failed", "provider_telemetry_unavailable"]);
  });
  it("alerts on old unresolved work without recent progress, with a grace period", () => {
    expect(operationsAlerts({ ...baseline, backlog: 1, oldestUnresolvedAt: old }, now)[0]?.code).toBe("consolidation_stalled");
    expect(operationsAlerts({ ...baseline, backlog: 1, oldestUnresolvedAt: fresh }, now)).toEqual([]);
    expect(operationsAlerts({ ...baseline, backlog: 1, oldestUnresolvedAt: old, lastSuccessAt: fresh }, now)).toEqual([]);
  });
  it("alerts on a long-running processing run even when backlog is zero", () => {
    expect(operationsAlerts({ ...baseline, oldestProcessingAt: old }, now)[0]?.code).toBe("consolidation_stalled");
  });
});
