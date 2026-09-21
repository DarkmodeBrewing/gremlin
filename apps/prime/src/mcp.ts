import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  authenticatePrincipal,
  type AuthenticatedPrincipal
} from "./auth.js";
import type { Database } from "./database.js";
import {
  emitEvent,
  emitEventSchema,
  InvalidEventMetadataError
} from "./events.js";
import {
  appendInteraction,
  appendInteractionSchema,
  InvalidInteractionMetadataError
} from "./interactions.js";
import {
  getMemory,
  getMemoryTimeline,
  memoryParamsSchema,
  memoryTimelineSchema,
  searchMemories,
  searchRequestSchema,
  type MemoryRetrievalDependencies
} from "./memory-retrieval.js";
import { memoryNamespaceSchema } from "./memory-namespace.js";

type McpDependencies = MemoryRetrievalDependencies;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

function toolSuccess(value: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function toolError(code: string): ToolResult {
  return {
    content: [{ type: "text", text: code }],
    isError: true
  };
}

function createMcpServer(
  dependencies: McpDependencies,
  principal: AuthenticatedPrincipal
): McpServer {
  const server = new McpServer({ name: "gremlin-prime", version: "0.1.0" });

  server.registerTool(
    "memory.search",
    {
      description: "Search the caller's authorized Gremlin memories.",
      inputSchema: {
        limit: z.number().int().min(1).max(20).default(5),
        query: z.string().min(1).max(20_000)
      }
    },
    async (input) => {
      const result = searchRequestSchema.safeParse(input);

      if (!result.success) {
        return toolError("invalid_request");
      }

      try {
        const memories = await searchMemories(
          dependencies,
          principal.id,
          result.data.query,
          result.data.limit
        );
        return toolSuccess({ memories });
      } catch {
        return toolError("memory_search_failed");
      }
    }
  );

  server.registerTool(
    "memory.get",
    {
      description: "Retrieve one authorized Gremlin memory by ID.",
      inputSchema: { id: z.string().uuid() }
    },
    async (input) => {
      const result = memoryParamsSchema.safeParse(input);

      if (!result.success) {
        return toolError("invalid_request");
      }

      const memory = await getMemory(dependencies.database, principal.id, result.data.id);
      return memory === null ? toolError("not_found") : toolSuccess({ memory });
    }
  );

  server.registerTool(
    "memory.timeline",
    {
      description:
        "List the caller's authorized memories in reverse chronological order.",
      inputSchema: {
        from: z.string().datetime({ offset: true }).optional(),
        includeDescendants: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(20),
        namespace: memoryNamespaceSchema.optional(),
        to: z.string().datetime({ offset: true }).optional()
      }
    },
    async (input) => {
      const result = memoryTimelineSchema.safeParse(input);

      if (!result.success) {
        return toolError("invalid_request");
      }

      const memories = await getMemoryTimeline(
        dependencies.database,
        principal.id,
        result.data
      );
      return toolSuccess({ memories });
    }
  );

  server.registerTool(
    "interaction.append",
    {
      description: "Append canonical interaction history as the authenticated principal.",
      inputSchema: {
        content: z.string().min(1).max(100_000),
        conversationId: z.string().uuid(),
        metadata: z.record(z.string(), z.unknown()).default({}),
        role: z.enum(["user", "assistant", "system", "tool"]),
        timestamp: z.string().datetime({ offset: true })
      }
    },
    async (input) => {
      if (!principal.canIngestInteractions) {
        return toolError("forbidden");
      }

      const result = appendInteractionSchema.safeParse(input);

      if (!result.success) {
        return toolError("invalid_request");
      }

      try {
        const interaction = await appendInteraction(
          dependencies.database,
          principal.id,
          result.data
        );
        return toolSuccess({ interaction });
      } catch (error: unknown) {
        if (error instanceof InvalidInteractionMetadataError) {
          return toolError("invalid_metadata");
        }

        throw error;
      }
    }
  );

  server.registerTool(
    "event.emit",
    {
      description: "Append a canonical event as the authenticated principal.",
      inputSchema: {
        content: z.string().min(1).max(100_000),
        metadata: z.record(z.string(), z.unknown()).default({}),
        timestamp: z.string().datetime({ offset: true }),
        type: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[a-z0-9]+([.-][a-z0-9]+)*$/)
      }
    },
    async (input) => {
      if (!principal.canIngestEvents) {
        return toolError("forbidden");
      }

      const result = emitEventSchema.safeParse(input);

      if (!result.success) {
        return toolError("invalid_request");
      }

      try {
        const event = await emitEvent(
          dependencies.database,
          principal.id,
          result.data
        );
        return toolSuccess({ event });
      } catch (error: unknown) {
        if (error instanceof InvalidEventMetadataError) {
          return toolError("invalid_metadata");
        }

        throw error;
      }
    }
  );

  return server;
}

function sendUnauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .header("WWW-Authenticate", "Bearer")
    .code(401)
    .send({ error: "unauthorized" });
}

export function registerMcpRoutes(
  server: FastifyInstance,
  dependencies: McpDependencies
): void {
  const sessions = new Map<
    string,
    Readonly<{
      mcpServer: McpServer;
      principalId: string;
      transport: StreamableHTTPServerTransport;
    }>
  >();

  server.post("/mcp", async (request, reply) => {
    const principal = await authenticatePrincipal(request, dependencies.database);

    if (principal === null) {
      return sendUnauthorized(reply);
    }

    const sessionId = request.headers["mcp-session-id"];
    const existingSession =
      typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (existingSession !== undefined) {
      if (existingSession.principalId !== principal.id) {
        return reply.code(404).send({ error: "not_found" });
      }

      reply.hijack();
      await existingSession.transport.handleRequest(
        request.raw,
        reply.raw,
        request.body
      );
      return;
    }

    if (sessionId !== undefined || !isInitializeRequest(request.body)) {
      return reply.code(400).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing MCP session" },
        id: null
      });
    }

    const mcpServer = createMcpServer(dependencies, principal);
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: randomUUID,
      onsessionclosed: async (closedSessionId) => {
        const session = sessions.get(closedSessionId);
        sessions.delete(closedSessionId);
        await session?.mcpServer.close();
      },
      onsessioninitialized: (initializedSessionId) => {
        sessions.set(initializedSessionId, {
          mcpServer,
          principalId: principal.id,
          transport
        });
      }
    });

    try {
      // SDK 1.30's Node adapter predates exactOptionalPropertyTypes on the
      // shared Transport declaration, but implements the runtime contract.
      await mcpServer.connect(transport as unknown as Transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error: unknown) {
      request.log.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          operation: "mcp.request",
          principal: principal.id
        },
        "MCP request failed"
      );

      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "Content-Type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null
          })
        );
      }
      await transport.close();
      await mcpServer.close();
    }
  });

  for (const method of ["GET", "DELETE"] as const) {
    server.route({
      method,
      url: "/mcp",
      handler: async (request, reply) => {
        const principal = await authenticatePrincipal(request, dependencies.database);

        if (principal === null) {
          return sendUnauthorized(reply);
        }

        const sessionId = request.headers["mcp-session-id"];
        const session =
          typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

        if (session === undefined || session.principalId !== principal.id) {
          return reply.code(404).send({ error: "not_found" });
        }

        reply.hijack();
        await session.transport.handleRequest(request.raw, reply.raw);
      }
    });
  }

  server.addHook("onClose", async () => {
    await Promise.all(
      [...sessions.values()].map(async ({ mcpServer, transport }) => {
        await transport.close();
        await mcpServer.close();
      })
    );
    sessions.clear();
  });
}
