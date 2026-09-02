import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication } from "../src/application.js";
import type { OpenRouterClient } from "../src/openrouter-client.js";
import type { PrimeClient } from "../src/prime-client.js";

const conversationId = "019c51d9-d7e6-7e1f-a399-ff70a508b047";
const userInteractionId = "019c51d9-d7e6-7e1f-a399-ff70a508b048";
const assistantInteractionId = "019c51d9-d7e6-7e1f-a399-ff70a508b049";
const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function createPrimeClient(): PrimeClient {
  let calls = 0;

  return {
    async appendInteraction() {
      calls += 1;
      return { id: calls === 1 ? userInteractionId : assistantInteractionId };
    },
    async checkHealth() {}
  };
}

function createOpenRouterClient(): OpenRouterClient {
  return {
    async streamCompletion(_messages, onDelta) {
      onDelta("Hello");
      onDelta(" Lars");
      return {
        content: "Hello Lars",
        finishReason: "stop",
        generationId: "generation-123"
      };
    }
  };
}

describe("POST /api/chat", () => {
  it("archives both turns and streams the assistant response", async () => {
    const primeClient = createPrimeClient();
    const appendInteraction = vi.spyOn(primeClient, "appendInteraction");
    const server = await buildApplication({
      logLevel: false,
      model: "example/model",
      openRouterClient: createOpenRouterClient(),
      primeClient
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId,
        messages: [{ content: "Hi", role: "user" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('event: delta\ndata: {"content":"Hello"}');
    expect(response.body).toContain(
      'event: complete\ndata: {"persisted":true}'
    );
    expect(appendInteraction).toHaveBeenCalledTimes(2);
    expect(appendInteraction.mock.calls[0]?.[0]).toMatchObject({
      content: "Hi",
      conversationId,
      role: "user"
    });
    expect(appendInteraction.mock.calls[1]?.[0]).toMatchObject({
      content: "Hello Lars",
      conversationId,
      metadata: {
        model: "example/model",
        provider: "openrouter",
        status: "complete"
      },
      role: "assistant"
    });
  });

  it("does not call OpenRouter when the user interaction cannot be archived", async () => {
    const streamCompletion = vi.fn();
    const primeClient: PrimeClient = {
      async appendInteraction() {
        throw new Error("Prime unavailable");
      },
      async checkHealth() {}
    };
    const server = await buildApplication({
      logLevel: false,
      model: "example/model",
      openRouterClient: { streamCompletion },
      primeClient
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId,
        messages: [{ content: "Hi", role: "user" }]
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "interaction_ingestion_failed" });
    expect(streamCompletion).not.toHaveBeenCalled();
  });

  it("makes assistant ingestion failure visible after streaming", async () => {
    let calls = 0;
    const primeClient: PrimeClient = {
      async appendInteraction() {
        calls += 1;

        if (calls === 2) {
          throw new Error("Prime unavailable");
        }

        return { id: userInteractionId };
      },
      async checkHealth() {}
    };
    const server = await buildApplication({
      logLevel: false,
      model: "example/model",
      openRouterClient: createOpenRouterClient(),
      primeClient
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId,
        messages: [{ content: "Hi", role: "user" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      'event: interaction\ndata: {"id":null,"persisted":false,"role":"assistant"}'
    );
    expect(response.body).toContain(
      'event: complete\ndata: {"persisted":false}'
    );
  });

  it("archives visible partial output when OpenRouter fails mid-stream", async () => {
    const primeClient = createPrimeClient();
    const appendInteraction = vi.spyOn(primeClient, "appendInteraction");
    const openRouterClient: OpenRouterClient = {
      async streamCompletion(_messages, onDelta) {
        onDelta("Partial response");
        throw new Error("Provider disconnected");
      }
    };
    const server = await buildApplication({
      logLevel: false,
      model: "example/model",
      openRouterClient,
      primeClient
    });
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId,
        messages: [{ content: "Hi", role: "user" }]
      }
    });

    expect(response.body).toContain(
      'event: error\ndata: {"code":"model_response_failed","partialPersisted":true}'
    );
    expect(appendInteraction.mock.calls[1]?.[0]).toMatchObject({
      content: "Partial response",
      metadata: { status: "incomplete" },
      role: "assistant"
    });
  });
});

describe("GET /health", () => {
  it("distinguishes Prime failure from health", async () => {
    const server = await buildApplication({
      logLevel: false,
      model: "example/model",
      openRouterClient: createOpenRouterClient(),
      primeClient: {
        async appendInteraction() {
          return { id: userInteractionId };
        },
        async checkHealth() {
          throw new Error("Prime unavailable");
        }
      }
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      dependencies: { prime: "unavailable" }
    });
  });
});

describe("browser UI", () => {
  it("serves the chat shell with restrictive browser headers", async () => {
    const server = await buildApplication({
      logLevel: false,
      model: "example/model",
      openRouterClient: createOpenRouterClient(),
      primeClient: createPrimeClient()
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Gremlin Chat");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'"
    );
  });
});
