import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FastifyInstance } from "fastify";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../../src/application.js";
import { createApiKey, hashApiKey } from "../../src/auth.js";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for integration tests");
}

type RegisteredPrincipal = Readonly<{
  apiKey: string;
  id: string;
}>;

describe("cross-client memory continuity", () => {
  let database: Sql;
  let server: FastifyInstance;
  let mcpUrl: URL;
  const clients: Client[] = [];

  beforeAll(async () => {
    database = postgres(databaseUrl, { max: 5 });
    server = await buildApplication({
      consolidation: {
        batchSize: 20,
        embeddingProvider: {
          configuredModel: "test-embedding",
          embedMany: async (texts) => ({
            embeddings: texts.map(() => [1, 0, 0]),
            model: "test-embedding"
          }),
          name: "test-embedding"
        },
        maxSourceCharacters: 200_000,
        provider: {
          consolidate: async (interactions) =>
            interactions.map((interaction) => {
              const isProjectFact = interaction.content.includes("Project Sable");

              return {
                confidence: 0.99,
                content: isProjectFact
                  ? "Project Sable uses violet deployments because they are reversible."
                  : "The private budget marker is seven.",
                evidenceInteractionIds: [interaction.id],
                namespace: isProjectFact
                  ? "projects/gremlin"
                  : "personal/finance"
              };
            }),
          model: "test-consolidator",
          name: "test-consolidation"
        }
      },
      database,
      logLevel: false
    });
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    mcpUrl = new URL("/mcp", address);
  });

  beforeEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await database`
      TRUNCATE
        consolidation_runs,
        embedding_models,
        interactions,
        principals
      CASCADE
    `;
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await server.close();
    await database.end({ timeout: 5 });
  });

  async function registerPrincipal(
    id: string,
    permissions: Readonly<{
      canConsolidate?: boolean;
      canIngestInteractions?: boolean;
    }> = {}
  ): Promise<RegisteredPrincipal> {
    const apiKey = createApiKey();

    await database`
      INSERT INTO principals (
        principal_id,
        api_key_hash,
        can_ingest_interactions,
        can_consolidate
      )
      VALUES (
        ${id},
        ${hashApiKey(apiKey)},
        ${permissions.canIngestInteractions ?? false},
        ${permissions.canConsolidate ?? false}
      )
    `;

    return { apiKey, id };
  }

  async function appendInteraction(
    principal: RegisteredPrincipal,
    content: string
  ): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/interactions",
      headers: { authorization: `Bearer ${principal.apiKey}` },
      payload: {
        content,
        conversationId: randomUUID(),
        metadata: { client: "gremlin-chat" },
        role: "user",
        timestamp: new Date().toISOString()
      }
    });

    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function connectMcpClient(apiKey: string): Promise<Client> {
    const client = new Client({
      name: "opencode-cross-client-proof",
      version: "0.1.0"
    });
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {
        headers: { Authorization: `Bearer ${apiKey}` }
      }
    });

    await client.connect(transport as unknown as Transport);
    clients.push(client);
    return client;
  }

  it("carries an authorized memory from Client A to Client B without exposing raw history", async () => {
    const chat = await registerPrincipal("client:gremlin-chat", {
      canIngestInteractions: true
    });
    const consolidator = await registerPrincipal("system:consolidator", {
      canConsolidate: true
    });
    const opencode = await registerPrincipal("agent:opencode");

    const projectInteractionId = await appendInteraction(
      chat,
      "CLIENT_A_RAW_ONLY_MARKER: Project Sable uses violet deployments because rollback must remain reversible."
    );
    await appendInteraction(
      chat,
      "CLIENT_A_PRIVATE_MARKER: the private budget marker is seven."
    );

    const consolidationResponse = await server.inject({
      method: "POST",
      url: "/admin/consolidate",
      headers: { authorization: `Bearer ${consolidator.apiKey}` },
      payload: {}
    });

    expect(consolidationResponse.statusCode).toBe(200);
    expect(consolidationResponse.json()).toMatchObject({
      memoryCount: 2,
      sourceCount: 2,
      status: "succeeded"
    });

    await database`
      INSERT INTO principal_memory_read_policies (
        principal_id,
        namespace_prefix,
        include_descendants
      )
      VALUES (${opencode.id}, 'projects/gremlin', false)
    `;

    const memoryRows = await database<
      Array<{ id: string; namespace: string }>
    >`
      SELECT id::text, namespace
      FROM memories
      ORDER BY namespace
    `;
    const authorizedMemoryId = memoryRows.find(
      (memory) => memory.namespace === "projects/gremlin"
    )?.id;
    const forbiddenMemoryId = memoryRows.find(
      (memory) => memory.namespace === "personal/finance"
    )?.id;

    expect(authorizedMemoryId).toBeDefined();
    expect(forbiddenMemoryId).toBeDefined();

    const evidenceRows = await database<
      Array<{ interaction_id: string; source_principal: string }>
    >`
      SELECT
        evidence.interaction_id::text,
        interaction.source_principal
      FROM memory_evidence evidence
      JOIN interactions interaction ON interaction.id = evidence.interaction_id
      WHERE evidence.memory_id = ${authorizedMemoryId}
    `;
    expect(evidenceRows).toEqual([
      {
        interaction_id: projectInteractionId,
        source_principal: chat.id
      }
    ]);

    const client = await connectMcpClient(opencode.apiKey);
    const searchResult = await client.callTool({
      name: "memory.search",
      arguments: {
        limit: 5,
        query: "Which deployment colour does Project Sable use, and why?"
      }
    });
    const searchPayload = JSON.stringify(searchResult);

    expect(searchResult.isError).not.toBe(true);
    expect(searchPayload).toContain(
      "Project Sable uses violet deployments because they are reversible."
    );
    expect(searchPayload).not.toContain("private budget marker");
    expect(searchPayload).not.toContain("CLIENT_A_RAW_ONLY_MARKER");
    expect(searchPayload).not.toContain("CLIENT_A_PRIVATE_MARKER");

    const authorizedGet = await client.callTool({
      name: "memory.get",
      arguments: { id: authorizedMemoryId }
    });
    const forbiddenGet = await client.callTool({
      name: "memory.get",
      arguments: { id: forbiddenMemoryId }
    });

    expect(authorizedGet.isError).not.toBe(true);
    expect(JSON.stringify(authorizedGet)).toContain("projects/gremlin");
    expect(forbiddenGet.isError).toBe(true);
    expect(JSON.stringify(forbiddenGet)).not.toContain("personal/finance");

    const rawHistoryAttempt = await server.inject({
      method: "GET",
      url: `/interactions/${projectInteractionId}`,
      headers: { authorization: `Bearer ${opencode.apiKey}` }
    });

    expect(rawHistoryAttempt.statusCode).toBe(404);
    expect(rawHistoryAttempt.body).not.toContain("CLIENT_A_RAW_ONLY_MARKER");
  });
});
