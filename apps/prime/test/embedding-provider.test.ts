import { describe, expect, it, vi } from "vitest";

import {
  createOpenRouterEmbeddingProvider,
  EmbeddingProviderError
} from "../src/embedding-provider.js";

describe("OpenRouter embedding provider", () => {
  it("restores provider results to input order", async () => {
    const provider = createOpenRouterEmbeddingProvider({
      apiKey: "test-key",
      fetchImplementation: vi.fn<typeof fetch>(async () =>
        new Response(
          JSON.stringify({
            data: [
              { embedding: [0.3, 0.4], index: 1 },
              { embedding: [0.1, 0.2], index: 0 }
            ],
            model: "example/embedding"
          }),
          { status: 200 }
        )
      ),
      model: "example/embedding",
      timeoutMilliseconds: 1_000
    });

    await expect(provider.embedMany(["first", "second"])).resolves.toEqual({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4]
      ],
      model: "example/embedding"
    });
  });

  it("rejects inconsistent embedding dimensions", async () => {
    const provider = createOpenRouterEmbeddingProvider({
      apiKey: "test-key",
      fetchImplementation: vi.fn<typeof fetch>(async () =>
        new Response(
          JSON.stringify({
            data: [
              { embedding: [0.1, 0.2], index: 0 },
              { embedding: [0.3], index: 1 }
            ],
            model: "example/embedding"
          }),
          { status: 200 }
        )
      ),
      model: "example/embedding",
      timeoutMilliseconds: 1_000
    });

    await expect(provider.embedMany(["first", "second"])).rejects.toBeInstanceOf(
      EmbeddingProviderError
    );
  });
});
