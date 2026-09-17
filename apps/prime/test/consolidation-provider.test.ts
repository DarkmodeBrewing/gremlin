import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ConsolidationProviderError,
  createOpenRouterConsolidationProvider,
  type SourceInteraction
} from "../src/consolidation-provider.js";

function sourceInteraction(): SourceInteraction {
  return {
    content: "Gremlin preserves immutable history.",
    conversationId: randomUUID(),
    id: randomUUID(),
    occurredAt: new Date("2026-09-17T20:00:00Z"),
    role: "user",
    sourcePrincipal: "client:gremlin-chat"
  };
}

describe("OpenRouter consolidation provider", () => {
  it("requests schema-constrained output and validates candidate memories", async () => {
    const source = sourceInteraction();
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        response_format: { json_schema: { strict: boolean }; type: string };
      };

      expect(request.response_format).toMatchObject({
        json_schema: { strict: true },
        type: "json_schema"
      });

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memories: [
                    {
                      confidence: 0.99,
                      content: "Gremlin preserves immutable history.",
                      evidenceInteractionIds: [source.id],
                      namespace: "projects/gremlin"
                    }
                  ]
                })
              }
            }
          ],
          model: "example/consolidator"
        }),
        { status: 200 }
      );
    });
    const provider = createOpenRouterConsolidationProvider({
      apiKey: "test-key",
      fetchImplementation,
      model: "example/consolidator",
      timeoutMilliseconds: 1_000
    });

    await expect(provider.consolidate([source])).resolves.toEqual([
      {
        confidence: 0.99,
        content: "Gremlin preserves immutable history.",
        evidenceInteractionIds: [source.id],
        namespace: "projects/gremlin"
      }
    ]);
  });

  it("rejects malformed model output", async () => {
    const provider = createOpenRouterConsolidationProvider({
      apiKey: "test-key",
      fetchImplementation: vi.fn<typeof fetch>(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    memories: [{ content: "Missing required fields" }]
                  })
                }
              }
            ]
          }),
          { status: 200 }
        )
      ),
      model: "example/consolidator",
      timeoutMilliseconds: 1_000
    });

    await expect(provider.consolidate([sourceInteraction()])).rejects.toBeInstanceOf(
      ConsolidationProviderError
    );
  });

  it("rejects malformed namespaces without vulnerable backtracking", async () => {
    const source = sourceInteraction();
    const provider = createOpenRouterConsolidationProvider({
      apiKey: "test-key",
      fetchImplementation: vi.fn<typeof fetch>(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    memories: [
                      {
                        confidence: 0.9,
                        content: "Invalid namespace",
                        evidenceInteractionIds: [source.id],
                        namespace: `0-0${"-0".repeat(2_000)}`
                      }
                    ]
                  })
                }
              }
            ]
          }),
          { status: 200 }
        )
      ),
      model: "example/consolidator",
      timeoutMilliseconds: 1_000
    });

    await expect(provider.consolidate([source])).rejects.toBeInstanceOf(
      ConsolidationProviderError
    );
  });
});
