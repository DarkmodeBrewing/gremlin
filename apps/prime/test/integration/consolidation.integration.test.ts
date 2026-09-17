import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApplication } from "../../src/application.js";
import { createApiKey, hashApiKey } from "../../src/auth.js";
import type {
  CandidateMemory,
  ConsolidationProvider,
  SourceInteraction
} from "../../src/consolidation-provider.js";
import type { EmbeddingProvider } from "../../src/embedding-provider.js";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for integration tests");
}

type RegisteredPrincipal = Readonly<{
  apiKey: string;
  id: string;
}>;

describe("manual consolidation", () => {
  let database: Sql;
  let server: FastifyInstance;
  let candidateFactory: (
    interactions: readonly SourceInteraction[]
  ) => readonly CandidateMemory[];
  const consolidate = vi.fn<ConsolidationProvider["consolidate"]>();
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
          consolidate,
          model: "example/consolidator",
          name: "test-consolidation"
        },
        rateLimit: { maximum: 100, windowMilliseconds: 60_000 }
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
    candidateFactory = (interactions) => [
      {
        confidence: 0.98,
        content: "Gremlin's canonical interaction history is immutable.",
        evidenceInteractionIds: interactions.map((interaction) => interaction.id),
        namespace: "projects/gremlin"
      }
    ];
    consolidate.mockImplementation(async (interactions) =>
      candidateFactory(interactions)
    );
    embedMany.mockResolvedValue({
      embeddings: [[0.1, 0.2, 0.3]],
      model: "example/embedding"
    });
  });

  afterAll(async () => {
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
    content: string,
    role: "assistant" | "user"
  ): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/interactions",
      headers: { authorization: `Bearer ${principal.apiKey}` },
      payload: {
        content,
        conversationId: randomUUID(),
        metadata: {},
        role,
        timestamp: new Date().toISOString()
      }
    });

    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  it("persists validated memories, embeddings, and complete evidence", async () => {
    const chat = await registerPrincipal("client:gremlin-chat", {
      canIngestInteractions: true
    });
    const consolidator = await registerPrincipal("system:consolidator", {
      canConsolidate: true
    });
    const userInteractionId = await appendInteraction(
      chat,
      "Gremlin's canonical interaction history is immutable.",
      "user"
    );
    const assistantInteractionId = await appendInteraction(
      chat,
      "I will preserve the raw interaction archive.",
      "assistant"
    );

    const response = await server.inject({
      method: "POST",
      url: "/admin/consolidate",
      headers: { authorization: `Bearer ${consolidator.apiKey}` },
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      memoryCount: 1,
      sourceCount: 2,
      status: "succeeded"
    });
    expect(consolidate).toHaveBeenCalledOnce();
    expect(embedMany).toHaveBeenCalledWith([
      "Gremlin's canonical interaction history is immutable."
    ]);

    const memoryRows = await database<
      Array<{
        confidence: number;
        content: string;
        dimensions: number;
        embedding: string;
        evidence_ids: string[];
        generated_by: string;
        namespace: string;
      }>
    >`
      SELECT
        m.namespace,
        m.content,
        m.confidence,
        m.embedding::text AS embedding,
        m.generated_by,
        em.dimensions,
        array_agg(me.interaction_id::text ORDER BY me.interaction_id) AS evidence_ids
      FROM memories m
      JOIN embedding_models em ON em.model_id = m.embedding_model_id
      JOIN memory_evidence me ON me.memory_id = m.id
      GROUP BY m.id, em.dimensions
    `;

    expect(memoryRows).toHaveLength(1);
    expect(memoryRows[0]).toMatchObject({
      confidence: 0.98,
      content: "Gremlin's canonical interaction history is immutable.",
      dimensions: 3,
      embedding: "[0.1,0.2,0.3]",
      namespace: "projects/gremlin"
    });
    expect(memoryRows[0]?.generated_by).toContain("gremlin-consolidator-v1");
    expect(memoryRows[0]?.evidence_ids).toEqual(
      [userInteractionId, assistantInteractionId].sort()
    );

    const emptyResponse = await server.inject({
      method: "POST",
      url: "/admin/consolidate",
      headers: { authorization: `Bearer ${consolidator.apiKey}` },
      payload: {}
    });

    expect(emptyResponse.statusCode).toBe(200);
    expect(emptyResponse.json()).toMatchObject({
      memoryCount: 0,
      sourceCount: 0,
      status: "succeeded"
    });
    expect(consolidate).toHaveBeenCalledOnce();
  });

  it("requires a separately authorized consolidation principal", async () => {
    const ordinaryClient = await registerPrincipal("client:gremlin-chat", {
      canIngestInteractions: true
    });

    const unauthenticated = await server.inject({
      method: "POST",
      url: "/admin/consolidate",
      payload: {}
    });
    const forbidden = await server.inject({
      method: "POST",
      url: "/admin/consolidate",
      headers: { authorization: `Bearer ${ordinaryClient.apiKey}` },
      payload: {}
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
    expect(consolidate).not.toHaveBeenCalled();
  });

  it("rejects foreign evidence and leaves failed sources retryable", async () => {
    const chat = await registerPrincipal("client:gremlin-chat", {
      canIngestInteractions: true
    });
    const consolidator = await registerPrincipal("system:consolidator", {
      canConsolidate: true
    });
    const interactionId = await appendInteraction(
      chat,
      "This source must remain retryable after malformed output.",
      "user"
    );
    candidateFactory = () => [
      {
        confidence: 0.8,
        content: "Invalid candidate",
        evidenceInteractionIds: [randomUUID()],
        namespace: "projects/gremlin"
      }
    ];

    const failedResponse = await server.inject({
      method: "POST",
      url: "/admin/consolidate",
      headers: { authorization: `Bearer ${consolidator.apiKey}` },
      payload: {}
    });

    expect(failedResponse.statusCode).toBe(502);
    expect(failedResponse.json()).toMatchObject({ error: "consolidation_failed" });

    const failedRows = await database<
      Array<{ error_code: string; source_status: string; status: string }>
    >`
      SELECT
        run.status,
        run.error_code,
        source.status AS source_status
      FROM consolidation_runs run
      JOIN consolidation_run_sources source ON source.run_id = run.id
    `;
    expect(failedRows).toEqual([
      {
        error_code: "provider_failure",
        source_status: "failed",
        status: "failed"
      }
    ]);

    candidateFactory = () => [
      {
        confidence: 0.9,
        content: "The failed source was retried safely.",
        evidenceInteractionIds: [interactionId],
        namespace: "projects/gremlin"
      }
    ];
    const retryResponse = await server.inject({
      method: "POST",
      url: "/admin/consolidate",
      headers: { authorization: `Bearer ${consolidator.apiKey}` },
      payload: {}
    });

    expect(retryResponse.statusCode).toBe(200);
    expect(retryResponse.json()).toMatchObject({ memoryCount: 1, sourceCount: 1 });
  });

  it("records an embedding failure without persisting partial memory", async () => {
    const chat = await registerPrincipal("client:gremlin-chat", {
      canIngestInteractions: true
    });
    const consolidator = await registerPrincipal("system:consolidator", {
      canConsolidate: true
    });
    await appendInteraction(chat, "Embedding failure test.", "user");
    embedMany.mockRejectedValueOnce(new Error("provider unavailable"));

    const response = await server.inject({
      method: "POST",
      url: "/admin/consolidate",
      headers: { authorization: `Bearer ${consolidator.apiKey}` },
      payload: {}
    });

    expect(response.statusCode).toBe(502);
    const rows = await database<
      Array<{ error_code: string; memory_count: number; status: string }>
    >`
      SELECT
        run.status,
        run.error_code,
        count(memory.id)::int AS memory_count
      FROM consolidation_runs run
      LEFT JOIN memories memory ON memory.consolidation_run_id = run.id
      GROUP BY run.id
    `;
    expect(rows).toEqual([
      { error_code: "embedding_failure", memory_count: 0, status: "failed" }
    ]);
  });
});
