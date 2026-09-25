import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApplication } from "../../src/application.js";
import { createApiKey, hashApiKey } from "../../src/auth.js";
import type { EmbeddingProvider } from "../../src/embedding-provider.js";
import { getMemoryTimeline } from "../../src/memory-retrieval.js";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for integration tests");
}

type RegisteredPrincipal = Readonly<{
  apiKey: string;
  id: string;
}>;

describe("authorized memory retrieval", () => {
  let database: Sql;
  let server: FastifyInstance;
  const embedMany = vi.fn<EmbeddingProvider["embedMany"]>();

  beforeAll(async () => {
    database = postgres(databaseUrl, { max: 5 });
    server = await buildApplication({
      consolidation: {
        batchSize: 20,
        embeddingProvider: {
          configuredModel: "example/embedding",
          embedMany,
          name: "test-embedding"
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
  });

  beforeEach(async () => {
    await database`
      TRUNCATE
        consolidation_runs,
        embedding_models,
        interactions,
        principals
      CASCADE
    `;
    vi.clearAllMocks();
    embedMany.mockResolvedValue({
      embeddings: [[1, 0, 0]],
      model: "example/embedding"
    });
  });

  afterAll(async () => {
    await server.close();
    await database.end({ timeout: 5 });
  });

  async function registerPrincipal(
    id: string,
    permissions: Readonly<{ canConsolidate?: boolean }> = {}
  ): Promise<RegisteredPrincipal> {
    const apiKey = createApiKey();

    await database`
      INSERT INTO principals (principal_id, api_key_hash, can_consolidate)
      VALUES (
        ${id},
        ${hashApiKey(apiKey)},
        ${permissions.canConsolidate ?? false}
      )
    `;

    return { apiKey, id };
  }

  async function grantRead(
    principalId: string,
    namespacePrefix: string,
    includeDescendants: boolean
  ): Promise<void> {
    await database`
      INSERT INTO principal_memory_read_policies (
        principal_id,
        namespace_prefix,
        include_descendants
      )
      VALUES (${principalId}, ${namespacePrefix}, ${includeDescendants})
    `;
  }

  async function seedMemory(options: Readonly<{
    content: string;
    embedding: readonly number[];
    namespace: string;
    requestedBy: string;
    sourcePrincipal?: string;
  }>): Promise<string> {
    const runRows = await database<Array<{ id: string }>>`
      INSERT INTO consolidation_runs (
        requested_by,
        provider,
        model,
        consolidator_version,
        status,
        completed_at
      )
      VALUES (
        ${options.requestedBy},
        'test',
        'test/consolidator',
        'test-v1',
        'succeeded',
        now()
      )
      RETURNING id
    `;
    const runId = runRows[0]?.id;

    if (runId === undefined) {
      throw new Error("Missing consolidation run");
    }

    await database`
      INSERT INTO embedding_models (model_id, provider, dimensions)
      VALUES ('example/embedding', 'test-embedding', 3)
      ON CONFLICT DO NOTHING
    `;
    const memoryRows = await database<Array<{ id: string }>>`
      INSERT INTO memories (
        namespace,
        content,
        confidence,
        embedding,
        embedding_model_id,
        generated_by,
        consolidation_run_id
      )
      VALUES (
        ${options.namespace},
        ${options.content},
        0.95,
        ${JSON.stringify(options.embedding)}::vector,
        'example/embedding',
        'test-v1',
        ${runId}
      )
      RETURNING id
    `;
    const memoryId = memoryRows[0]?.id;

    if (memoryId === undefined) {
      throw new Error("Missing memory");
    }

    if (options.sourcePrincipal !== undefined) {
      const interactionRows = await database<Array<{ id: string }>>`
        INSERT INTO interactions (
          conversation_id,
          occurred_at,
          source_principal,
          role,
          content
        )
        VALUES (
          ${randomUUID()},
          now(),
          ${options.sourcePrincipal},
          'user',
          'Evidence content'
        )
        RETURNING id
      `;
      const interactionId = interactionRows[0]?.id;

      if (interactionId === undefined) {
        throw new Error("Missing interaction");
      }

      await database`
        INSERT INTO memory_evidence (memory_id, interaction_id)
        VALUES (${memoryId}, ${interactionId})
      `;
      const eventRows = await database<Array<{ id: string }>>`
        INSERT INTO events (occurred_at, source_principal, type, content)
        VALUES (now(), ${options.sourcePrincipal}, 'test.observed', 'Event evidence')
        RETURNING id
      `;
      const eventId = eventRows[0]?.id;

      if (eventId === undefined) {
        throw new Error("Missing event");
      }

      await database`
        INSERT INTO memory_event_evidence (memory_id, event_id)
        VALUES (${memoryId}, ${eventId})
      `;
    }

    return memoryId;
  }

  it("filters namespaces inside semantic search and applies hierarchical grants", async () => {
    const reader = await registerPrincipal("client:gremlin-chat");
    const consolidator = await registerPrincipal("system:consolidator");
    await grantRead(reader.id, "user", true);
    await seedMemory({
      content: "User's cat is named Alvar.",
      embedding: [1, 0, 0],
      namespace: "user/pets",
      requestedBy: consolidator.id
    });
    await seedMemory({
      content: "User enjoys dark beer.",
      embedding: [0, 1, 0],
      namespace: "user/preferences",
      requestedBy: consolidator.id
    });
    await seedMemory({
      content: "This finance memory must never leave Prime.",
      embedding: [1, 0, 0],
      namespace: "finance",
      requestedBy: consolidator.id
    });
    await seedMemory({
      content: "A prefix-sibling namespace must not match the user grant.",
      embedding: [1, 0, 0],
      namespace: "userland/pets",
      requestedBy: consolidator.id
    });

    const response = await server.inject({
      method: "POST",
      url: "/memory/search",
      headers: { authorization: `Bearer ${reader.apiKey}` },
      payload: { limit: 5, query: "Do you know my cat?" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ memories: Array<{ content: string }> }>().memories).toEqual([
      expect.objectContaining({ content: "User's cat is named Alvar." }),
      expect.objectContaining({ content: "User enjoys dark beer." })
    ]);
    expect(response.body).not.toContain("finance memory");
    expect(response.body).not.toContain("prefix-sibling namespace");
    expect(embedMany).toHaveBeenCalledWith(["Do you know my cat?"]);
  });

  it("conceals unauthorized memory details and returns authorized provenance", async () => {
    const reader = await registerPrincipal("client:gremlin-chat");
    const consolidator = await registerPrincipal("system:consolidator");
    await grantRead(reader.id, "user", true);
    const allowedId = await seedMemory({
      content: "User's cat is named Alvar.",
      embedding: [1, 0, 0],
      namespace: "user/pets",
      requestedBy: consolidator.id,
      sourcePrincipal: reader.id
    });
    const forbiddenId = await seedMemory({
      content: "Private finance memory.",
      embedding: [1, 0, 0],
      namespace: "finance",
      requestedBy: consolidator.id
    });

    const allowed = await server.inject({
      method: "GET",
      url: `/memory/${allowedId}`,
      headers: { authorization: `Bearer ${reader.apiKey}` }
    });
    const forbidden = await server.inject({
      method: "GET",
      url: `/memory/${forbiddenId}`,
      headers: { authorization: `Bearer ${reader.apiKey}` }
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      content: "User's cat is named Alvar.",
      lifecycle: { status: "active" },
      namespace: "user/pets"
    });
    expect(allowed.json<{ evidenceInteractionIds: string[] }>().evidenceInteractionIds)
      .toHaveLength(1);
    expect(allowed.json<{ evidenceEventIds: string[] }>().evidenceEventIds)
      .toHaveLength(1);
    expect(forbidden.statusCode).toBe(404);
    expect(forbidden.body).not.toContain("finance");
  });

  it("invalidates memory append-only and excludes it from ordinary retrieval", async () => {
    const reader = await registerPrincipal("client:gremlin-chat");
    const consolidator = await registerPrincipal("system:consolidator", {
      canConsolidate: true
    });
    await grantRead(reader.id, "user", true);
    const invalidatedId = await seedMemory({
      content: "The obsolete memory must leave ordinary recall.",
      embedding: [1, 0, 0],
      namespace: "user/preferences",
      requestedBy: consolidator.id,
      sourcePrincipal: reader.id
    });
    const activeId = await seedMemory({
      content: "The active memory remains available.",
      embedding: [1, 0, 0],
      namespace: "user/preferences",
      requestedBy: consolidator.id
    });

    const forbidden = await server.inject({
      method: "POST",
      url: `/admin/memories/${invalidatedId}/invalidate`,
      headers: { authorization: `Bearer ${reader.apiKey}` },
      payload: { reason: "Reader principals cannot change lifecycle state." }
    });
    expect(forbidden.statusCode).toBe(403);

    const invalidated = await server.inject({
      method: "POST",
      url: `/admin/memories/${invalidatedId}/invalidate`,
      headers: { authorization: `Bearer ${consolidator.apiKey}` },
      payload: { reason: "Corrected by newer canonical evidence." }
    });
    expect(invalidated.statusCode).toBe(201);
    expect(invalidated.json()).toMatchObject({
      lifecycle: {
        action: "invalidated",
        memoryId: invalidatedId,
        reason: "Corrected by newer canonical evidence.",
        requestedBy: consolidator.id,
        supersedingMemoryId: null,
        supersedingRunId: null
      }
    });

    const search = await server.inject({
      method: "POST",
      url: "/memory/search",
      headers: { authorization: `Bearer ${reader.apiKey}` },
      payload: { limit: 5, query: "Which memory remains?" }
    });
    expect(search.statusCode).toBe(200);
    expect(search.json<{ memories: Array<{ id: string }> }>().memories).toEqual([
      expect.objectContaining({ id: activeId })
    ]);

    const timeline = await getMemoryTimeline(database, reader.id, {
      includeDescendants: true,
      limit: 20,
      namespace: "user"
    });
    expect(timeline.map((memory) => memory.id)).toEqual([activeId]);

    const historicalDetail = await server.inject({
      method: "GET",
      url: `/memory/${invalidatedId}`,
      headers: { authorization: `Bearer ${reader.apiKey}` }
    });
    expect(historicalDetail.statusCode).toBe(200);
    expect(historicalDetail.json()).toMatchObject({
      id: invalidatedId,
      lifecycle: {
        status: "invalidated",
        reason: "Corrected by newer canonical evidence.",
        requestedBy: consolidator.id,
        supersedingMemoryId: null,
        supersedingRunId: null
      }
    });
    expect(
      historicalDetail.json<{ evidenceInteractionIds: string[] }>()
        .evidenceInteractionIds
    ).toHaveLength(1);
    expect(
      historicalDetail.json<{ evidenceEventIds: string[] }>().evidenceEventIds
    ).toHaveLength(1);

    const repeated = await server.inject({
      method: "POST",
      url: `/admin/memories/${invalidatedId}/invalidate`,
      headers: { authorization: `Bearer ${consolidator.apiKey}` },
      payload: { reason: "A second terminal transition must not be appended." }
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toEqual({ error: "memory_not_active" });

    const counts = await database<
      Array<{
        event_evidence_count: number;
        interaction_evidence_count: number;
        lifecycle_count: number;
        memory_count: number;
      }>
    >`
      SELECT
        (SELECT count(*)::int FROM memories) AS memory_count,
        (SELECT count(*)::int FROM memory_lifecycle_events) AS lifecycle_count,
        (SELECT count(*)::int FROM memory_evidence) AS interaction_evidence_count,
        (SELECT count(*)::int FROM memory_event_evidence) AS event_evidence_count
    `;
    expect(counts[0]).toEqual({
      event_evidence_count: 1,
      interaction_evidence_count: 1,
      lifecycle_count: 1,
      memory_count: 2
    });
  });

  it("distinguishes embedding failure from an empty authorized result", async () => {
    const reader = await registerPrincipal("client:gremlin-chat");

    const empty = await server.inject({
      method: "POST",
      url: "/memory/search",
      headers: { authorization: `Bearer ${reader.apiKey}` },
      payload: { query: "Nothing stored" }
    });
    embedMany.mockRejectedValueOnce(new Error("provider unavailable"));
    const failed = await server.inject({
      method: "POST",
      url: "/memory/search",
      headers: { authorization: `Bearer ${reader.apiKey}` },
      payload: { query: "Provider failure" }
    });

    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ memories: [] });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: "memory_search_failed" });
  });
});
