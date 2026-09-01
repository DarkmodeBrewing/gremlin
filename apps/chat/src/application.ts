import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyReply } from "fastify";

import { chatRequestSchema } from "./contracts.js";
import type { OpenRouterClient } from "./openrouter-client.js";
import type { PrimeClient } from "./prime-client.js";
import { buildServer } from "./server.js";

const defaultStaticRoot = fileURLToPath(new URL("../public", import.meta.url));

export type ApplicationDependencies = Readonly<{
  logLevel: string | false;
  model: string;
  openRouterClient: OpenRouterClient;
  primeClient: PrimeClient;
  rateLimit?: Readonly<{
    maximum: number;
    windowMilliseconds: number;
  }>;
  staticRoot?: string;
}>;

function sendEvent(
  reply: FastifyReply,
  event: string,
  data: Readonly<Record<string, unknown>>
): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function safeErrorDetails(error: unknown): Record<string, unknown> {
  return {
    errorName: error instanceof Error ? error.name : "UnknownError"
  };
}

export async function buildApplication(
  dependencies: ApplicationDependencies
): Promise<FastifyInstance> {
  const server = await buildServer({
    logLevel: dependencies.logLevel,
    staticRoot: dependencies.staticRoot ?? defaultStaticRoot
  });

  server.get(
    "/health",
    {
      config: {
        rateLimit: false
      }
    },
    async (request, reply) => {
      try {
        await dependencies.primeClient.checkHealth();

        return {
          status: "ok",
          dependencies: { prime: "ok" }
        };
      } catch (error: unknown) {
        request.log.error(
          { ...safeErrorDetails(error), operation: "health.prime" },
          "Gremlin Prime health check failed"
        );

        return reply.code(503).send({
          status: "degraded",
          dependencies: { prime: "unavailable" }
        });
      }
    }
  );

  server.post(
    "/api/chat",
    {
      config: {
        rateLimit: {
          max: dependencies.rateLimit?.maximum ?? 30,
          timeWindow: dependencies.rateLimit?.windowMilliseconds ?? 60_000
        }
      }
    },
    async (request, reply) => {
      const result = chatRequestSchema.safeParse(request.body);

      if (!result.success) {
        return reply.code(400).send({
          error: "invalid_request",
          fields: [
            ...new Set(
              result.error.issues
                .map((issue) => issue.path.join("."))
                .filter((field) => field.length > 0)
            )
          ]
        });
      }

      const userMessage = result.data.messages.at(-1);

      if (userMessage === undefined || userMessage.role !== "user") {
        return reply.code(400).send({
          error: "invalid_request",
          fields: ["messages"]
        });
      }

      let userInteractionId: string;

      try {
        const archived = await dependencies.primeClient.appendInteraction({
          content: userMessage.content,
          conversationId: result.data.conversationId,
          metadata: { client: "gremlin-chat" },
          role: "user",
          timestamp: new Date().toISOString()
        });
        userInteractionId = archived.id;
      } catch (error: unknown) {
        request.log.error(
          { ...safeErrorDetails(error), operation: "interaction.user.append" },
          "User interaction ingestion failed"
        );

        return reply.code(503).send({ error: "interaction_ingestion_failed" });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no"
      });

      sendEvent(reply, "interaction", {
        id: userInteractionId,
        persisted: true,
        role: "user"
      });

      let streamedContent = "";
      const abortController = new AbortController();
      request.raw.once("aborted", () => abortController.abort());
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) {
          abortController.abort();
        }
      });

      try {
        const completion = await dependencies.openRouterClient.streamCompletion(
          result.data.messages,
          (content) => {
            streamedContent += content;
            sendEvent(reply, "delta", { content });
          },
          abortController.signal
        );

        let assistantInteractionId: string | null = null;

        try {
          const archived = await dependencies.primeClient.appendInteraction({
            content: completion.content,
            conversationId: result.data.conversationId,
            metadata: {
              client: "gremlin-chat",
              ...(completion.finishReason === null
                ? {}
                : { finishReason: completion.finishReason }),
              ...(completion.generationId === null
                ? {}
                : { generationId: completion.generationId }),
              model: dependencies.model,
              provider: "openrouter",
              status: "complete"
            },
            role: "assistant",
            timestamp: new Date().toISOString()
          });
          assistantInteractionId = archived.id;
        } catch (error: unknown) {
          request.log.error(
            { ...safeErrorDetails(error), operation: "interaction.assistant.append" },
            "Assistant interaction ingestion failed"
          );
        }

        sendEvent(reply, "interaction", {
          id: assistantInteractionId,
          persisted: assistantInteractionId !== null,
          role: "assistant"
        });
        sendEvent(reply, "complete", {
          persisted: assistantInteractionId !== null
        });
      } catch (error: unknown) {
        request.log.error(
          { ...safeErrorDetails(error), operation: "openrouter.stream" },
          "OpenRouter streaming failed"
        );

        let partialPersisted = false;

        if (streamedContent.length > 0) {
          try {
            await dependencies.primeClient.appendInteraction({
              content: streamedContent,
              conversationId: result.data.conversationId,
              metadata: {
                client: "gremlin-chat",
                model: dependencies.model,
                provider: "openrouter",
                status: "incomplete"
              },
              role: "assistant",
              timestamp: new Date().toISOString()
            });
            partialPersisted = true;
          } catch (ingestionError: unknown) {
            request.log.error(
              {
                ...safeErrorDetails(ingestionError),
                operation: "interaction.assistant.partial.append"
              },
              "Partial assistant interaction ingestion failed"
            );
          }
        }

        sendEvent(reply, "error", {
          code: "model_response_failed",
          partialPersisted
        });
      } finally {
        reply.raw.end();
      }
    }
  );

  return server;
}
