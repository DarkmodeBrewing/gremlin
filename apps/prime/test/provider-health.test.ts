import { describe, expect, it, vi } from "vitest";

import { createProviderHealth } from "../src/provider-health.js";

describe("provider HTTP observations", () => {
  it("starts unknown without calling the provider and never exposes secrets", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("private provider body", { status: 401 }));
    const health = createProviderHealth(request);
    expect(health.snapshot().embedding.status).toBe("not_observed");
    expect(request).not.toHaveBeenCalled();
    const response = await health.observe("embedding")("https://provider.example", {
      headers: { Authorization: "Bearer private-secret" }, body: "private prompt", method: "POST"
    });
    expect(response.status).toBe(401);
    expect(health.snapshot().embedding).toMatchObject({ status: "authentication_failed", httpStatus: 401 });
    expect(JSON.stringify(health.snapshot())).not.toContain("private");
    expect(health.snapshot().consolidation.status).toBe("not_observed");
  });

  it.each([
    [403, "authentication_failed"], [429, "rate_limited"],
    [503, "unavailable"], [400, "request_failed"]
  ])("classifies HTTP %s separately", async (status, expected) => {
    const health = createProviderHealth(async () => new Response(null, { status }));
    await health.observe("consolidation")("https://provider.example");
    expect(health.snapshot().consolidation.status).toBe(expected);
  });

  it("retains failure history after recovery and returns independent snapshots", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const health = createProviderHealth(request);
    await health.observe("embedding")("https://provider.example");
    const failed = health.snapshot();
    await health.observe("embedding")("https://provider.example");
    expect(health.snapshot().embedding).toMatchObject({ status: "ok", lastFailureAt: failed.embedding.lastFailureAt });
    expect(health.snapshot().embedding.lastSuccessAt).not.toBeNull();
    expect(failed.embedding.status).toBe("authentication_failed");
  });

  it("records transport failures without swallowing or exposing the error", async () => {
    const error = new Error("private-url-and-key");
    const health = createProviderHealth(async () => { throw error; });
    await expect(health.observe("embedding")("https://provider.example")).rejects.toBe(error);
    expect(health.snapshot().embedding).toMatchObject({ status: "unavailable", httpStatus: null });
    expect(JSON.stringify(health.snapshot())).not.toContain("private");
  });
});
