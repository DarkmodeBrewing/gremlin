import { describe, expect, it, vi } from "vitest";

import { createPrimeClient } from "../src/prime-client.js";

describe("PrimeClient", () => {
  it("authenticates server-side and returns the archived interaction ID", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ id: "019c51d9-d7e6-7e1f-a399-ff70a508b046" }),
          { status: 201 }
        )
    );
    const client = createPrimeClient({
      apiKey: "gremlin-secret",
      baseUrl: "http://prime.test/",
      fetchImplementation: fetchMock as unknown as typeof fetch
    });

    const archived = await client.appendInteraction({
      content: "Remember this",
      conversationId: "019c51d9-d7e6-7e1f-a399-ff70a508b047",
      metadata: { client: "gremlin-chat" },
      role: "user",
      timestamp: "2026-09-01T10:00:00.000Z"
    });

    expect(archived.id).toBe("019c51d9-d7e6-7e1f-a399-ff70a508b046");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer gremlin-secret"
    );
    expect(String(init?.body)).not.toContain("gremlin-secret");
  });
});
