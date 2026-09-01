import { describe, expect, it, vi } from "vitest";

import { createOpenRouterClient } from "../src/openrouter-client.js";

function streamResponse(events: string): Response {
  return new Response(events, {
    headers: {
      "Content-Type": "text/event-stream",
      "X-Generation-Id": "generation-123"
    }
  });
}

describe("OpenRouterClient", () => {
  it("parses deltas while ignoring SSE comments and the usage frame", async () => {
    const fetchImplementation = vi.fn(async () =>
      streamResponse(
        ': OPENROUTER PROCESSING\n\n' +
          'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n' +
          'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"total_tokens":4}}\n\n' +
          "data: [DONE]\n\n"
      )
    ) as unknown as typeof fetch;
    const client = createOpenRouterClient({
      apiKey: "secret",
      fetchImplementation,
      model: "example/model"
    });
    const deltas: string[] = [];

    const result = await client.streamCompletion(
      [{ content: "Hi", role: "user" }],
      (content) => deltas.push(content)
    );

    expect(deltas).toEqual(["Hello", " world"]);
    expect(result).toEqual({
      content: "Hello world",
      finishReason: "stop",
      generationId: "generation-123"
    });
  });

  it("treats a mid-stream error event as a failure", async () => {
    const fetchImplementation = vi.fn(async () =>
      streamResponse(
        'data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}\n\n' +
          'data: {"error":{"code":"server_error","message":"provider disconnected"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}\n\n'
      )
    ) as unknown as typeof fetch;
    const client = createOpenRouterClient({
      apiKey: "secret",
      fetchImplementation,
      model: "example/model"
    });
    const deltas: string[] = [];

    await expect(
      client.streamCompletion([{ content: "Hi", role: "user" }], (content) =>
        deltas.push(content)
      )
    ).rejects.toThrow("OpenRouter reported a streaming failure");
    expect(deltas).toEqual(["Partial"]);
  });

  it("does not expose an upstream error response body", async () => {
    const fetchImplementation = vi.fn(
      async () => new Response('{"error":{"message":"secret detail"}}', { status: 503 })
    ) as unknown as typeof fetch;
    const client = createOpenRouterClient({
      apiKey: "secret",
      fetchImplementation,
      model: "example/model"
    });

    await expect(
      client.streamCompletion([{ content: "Hi", role: "user" }], () => undefined)
    ).rejects.not.toThrow("secret detail");
  });
});
