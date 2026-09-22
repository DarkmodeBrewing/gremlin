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

type RegisteredPrincipal = Readonly<{ apiKey: string; id: string }>;

describe("MCP interface", () => {
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
          name: "test"
        },
        maxSourceCharacters: 200_000,
        provider: {
          consolidate: async () => [],
          model: "unused",
          name: "test"
        }
      },
      database,
      logLevel: false
    });
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    mcpUrl = new URL("/mcp", address);
  });

  beforeEach(async () => {
    await database`TRUNCATE events, memories, embedding_models, interactions, principals CASCADE`;
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await server.close();
    await database.end({ timeout: 5 });
  });

  async function registerPrincipal(
    id: string,
    permissions: Readonly<{
      canIngestEvents?: boolean;
      canIngestInteractions?: boolean;
    }> = {}
  ): Promise<RegisteredPrincipal> {
    const apiKey = createApiKey();

    await database`
      INSERT INTO principals (
        principal_id,
        api_key_hash,
        can_ingest_interactions,
        can_ingest_events
      )
      VALUES (
        ${id},
        ${hashApiKey(apiKey)},
        ${permissions.canIngestInteractions ?? false},
        ${permissions.canIngestEvents ?? false}
      )
    `;

    return { apiKey, id };
  }

  async function connectClient(apiKey: string): Promise<Client> {
    const client = new Client({ name: "gremlin-integration", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {
        headers: { Authorization: `Bearer ${apiKey}` }
      }
    });
    await client.connect(transport as unknown as Transport);
    clients.push(client);
    return client;
  }

  it("exposes the five M6 tools", async () => {
    const principal = await registerPrincipal("agent:opencode");
    const client = await connectClient(principal.apiKey);

    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "event.emit",
      "interaction.append",
      "memory.get",
      "memory.search",
      "memory.timeline"
    ]);
  });

  it("attributes interaction and event ingestion to the authenticated principal", async () => {
    const principal = await registerPrincipal("agent:opencode", {
      canIngestEvents: true,
      canIngestInteractions: true
    });
    const client = await connectClient(principal.apiKey);

    const interactionResult = await client.callTool({
      name: "interaction.append",
      arguments: {
        content: "MCP contributed this interaction.",
        conversationId: randomUUID(),
        metadata: { client: "integration" },
        role: "user",
        timestamp: new Date().toISOString()
      }
    });
    const eventResult = await client.callTool({
      name: "event.emit",
      arguments: {
        content: "Gremlin M6 was deployed.",
        metadata: { environment: "integration" },
        timestamp: new Date().toISOString(),
        type: "service.deployed"
      }
    });

    expect(interactionResult.isError).not.toBe(true);
    expect(eventResult.isError).not.toBe(true);
    const rows = await database<
      Array<{ kind: string; source_principal: string }>
    >`
      SELECT 'interaction' AS kind, source_principal FROM interactions
      UNION ALL
      SELECT 'event' AS kind, source_principal FROM events
      ORDER BY kind
    `;
    expect(rows).toEqual([
      { kind: "event", source_principal: principal.id },
      { kind: "interaction", source_principal: principal.id }
    ]);
  });

  it("enforces ingestion permissions through MCP", async () => {
    const principal = await registerPrincipal("agent:read-only");
    const client = await connectClient(principal.apiKey);

    const interactionResult = await client.callTool({
      name: "interaction.append",
      arguments: {
        content: "Must not persist.",
        conversationId: randomUUID(),
        role: "user",
        timestamp: new Date().toISOString()
      }
    });
    const eventResult = await client.callTool({
      name: "event.emit",
      arguments: {
        content: "Must not persist.",
        timestamp: new Date().toISOString(),
        type: "manual.note"
      }
    });

    expect(interactionResult.isError).toBe(true);
    expect(eventResult.isError).toBe(true);
    const rows = await database<Array<{ count: number }>>`
      SELECT (
        (SELECT count(*) FROM interactions) + (SELECT count(*) FROM events)
      )::int AS count
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it("applies namespace authorization to search, get, and timeline", async () => {
    const principal = await registerPrincipal("agent:opencode");
    const client = await connectClient(principal.apiKey);

    await database`
      INSERT INTO embedding_models (model_id, provider, dimensions)
      VALUES ('test-embedding', 'test', 3)
    `;
    const runRows = await database<Array<{ id: string }>>`
      INSERT INTO consolidation_runs (
        requested_by,
        provider,
        model,
        consolidator_version,
        status,
        completed_at
      )
      VALUES (${principal.id}, 'test', 'test', 'integration', 'succeeded', now())
      RETURNING id
    `;
    const runId = runRows[0]?.id;

    if (runId === undefined) {
      throw new Error("Consolidation run insert returned no record");
    }

    const memoryRows = await database<Array<{ id: string; namespace: string }>>`
      INSERT INTO memories (
        namespace,
        content,
        confidence,
        embedding,
        embedding_model_id,
        generated_by,
        consolidation_run_id
      )
      SELECT
        source.namespace,
        source.content,
        0.9,
        source.embedding::vector,
        'test-embedding',
        'integration',
        ${runId}
      FROM (
        VALUES
          ('projects/gremlin-prime', 'Authorized project memory', '[1,0,0]'),
          ('projects-secret/gremlin', 'Forbidden prefix-sibling memory', '[1,0,0]'),
          ('personal/finance', 'Forbidden personal memory', '[1,0,0]')
      ) AS source(namespace, content, embedding)
      RETURNING id, namespace
    `;
    await database`
      INSERT INTO principal_memory_read_policies (
        principal_id,
        namespace_prefix,
        include_descendants
      )
      VALUES (${principal.id}, 'projects', true)
    `;
    const authorizedId = memoryRows.find(
      (memory) => memory.namespace === "projects/gremlin-prime"
    )?.id;
    const forbiddenId = memoryRows.find(
      (memory) => memory.namespace === "personal/finance"
    )?.id;
    const prefixSiblingId = memoryRows.find(
      (memory) => memory.namespace === "projects-secret/gremlin"
    )?.id;

    expect(authorizedId).toBeDefined();
    expect(forbiddenId).toBeDefined();
    expect(prefixSiblingId).toBeDefined();

    const searchResult = await client.callTool({
      name: "memory.search",
      arguments: { query: "project" }
    });
    const timelineResult = await client.callTool({
      name: "memory.timeline",
      arguments: {}
    });
    const authorizedGet = await client.callTool({
      name: "memory.get",
      arguments: { id: authorizedId }
    });
    const forbiddenGet = await client.callTool({
      name: "memory.get",
      arguments: { id: forbiddenId }
    });
    const prefixSiblingGet = await client.callTool({
      name: "memory.get",
      arguments: { id: prefixSiblingId }
    });

    expect(JSON.stringify(searchResult)).toContain("Authorized project memory");
    expect(JSON.stringify(searchResult)).not.toContain("Forbidden personal memory");
    expect(JSON.stringify(searchResult)).not.toContain(
      "Forbidden prefix-sibling memory"
    );
    expect(JSON.stringify(timelineResult)).toContain("Authorized project memory");
    expect(JSON.stringify(timelineResult)).not.toContain("Forbidden personal memory");
    expect(JSON.stringify(timelineResult)).not.toContain(
      "Forbidden prefix-sibling memory"
    );
    expect(authorizedGet.isError).not.toBe(true);
    expect(forbiddenGet.isError).toBe(true);
    expect(prefixSiblingGet.isError).toBe(true);
  });
});
