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

  it("searches memory with the same server-side credential", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            memories: [
              {
                confidence: 0.95,
                content: "User's cat is named Alvar.",
                id: "019c51d9-d7e6-7e1f-a399-ff70a508b050",
                namespace: "user/pets",
                similarity: 0.91
              }
            ]
          }),
          { status: 200 }
        )
    );
    const client = createPrimeClient({
      apiKey: "gremlin-secret",
      baseUrl: "http://prime.test/",
      fetchImplementation: fetchMock as unknown as typeof fetch
    });

    const memories = await client.searchMemory("Do you know my cat?", 3);

    expect(memories[0]?.content).toBe("User's cat is named Alvar.");
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toBe("http://prime.test/memory/search");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer gremlin-secret"
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      limit: 3,
      query: "Do you know my cat?"
    });
  });
});
