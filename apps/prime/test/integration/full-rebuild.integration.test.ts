import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../../src/application.js";
import { createApiKey, hashApiKey } from "../../src/auth.js";
import type { CandidateMemory, ConsolidationSource } from "../../src/consolidation-provider.js";
import { recoverInterruptedConsolidationRuns } from "../../src/consolidation.js";
import { getMemory, getMemoryTimeline, searchMemories } from "../../src/memory-retrieval.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required for integration tests");

describe("full memory rebuild", () => {
  let database: Sql;
  let server: FastifyInstance;
  let apiKey: string;
  let embeddingModel: string;
  let derive: (sources: readonly ConsolidationSource[]) => Promise<readonly CandidateMemory[]>;
  const principalId = "system:consolidator";

  const memory = (sources: readonly ConsolidationSource[], content: string): CandidateMemory => ({
    namespace: "projects/rebuild", content, confidence: 0.95,
    evidence: sources.map((source) => ({ kind: source.kind, id: source.id }))
  });
  const retrieval = () => ({ database, embeddingProvider: {
    name: "test", configuredModel: "new-model",
    embedMany: async (texts: readonly string[], model?: string) => ({
      model: model ?? embeddingModel, embeddings: texts.map(() => [1, 0, 0])
    })
  } });

  async function createServer(batchSize: number) {
    return buildApplication({
      database, logLevel: false,
      consolidation: {
        batchSize, maxSourceCharacters: 200_000,
        provider: { name: "test", model: "test", consolidate: (sources) => derive(sources) },
        embeddingProvider: {
          configuredModel: "new-model", name: "test",
          embedMany: async (texts, model) => ({
            model: model ?? embeddingModel,
            embeddings: texts.map(() => [1, 0, 0])
          })
        },
        rateLimit: { maximum: 100, windowMilliseconds: 60_000 }
      }
    });
  }

  beforeAll(async () => {
    database = postgres(databaseUrl, { max: 8 });
    server = await createServer(20);
  });

  beforeEach(async () => {
    await database`TRUNCATE consolidation_runs, embedding_models, interactions, events, principals CASCADE`;
    apiKey = createApiKey();
    embeddingModel = "old-model";
    derive = async (sources) => [memory(sources, "Previous interpretation")];
    await database`INSERT INTO principals (principal_id, api_key_hash, can_consolidate)
      VALUES (${principalId}, ${hashApiKey(apiKey)}, true)`;
    await database`INSERT INTO principal_memory_read_policies
      (principal_id, namespace_prefix, include_descendants)
      VALUES (${principalId}, 'projects/rebuild', false)`;
  });

  afterAll(async () => {
    await server.close();
    await database.end({ timeout: 5 });
  });

  async function seedSources() {
    const interactionId = randomUUID();
    const eventId = randomUUID();
    await database`INSERT INTO interactions (id, conversation_id, occurred_at, source_principal, role, content)
      VALUES (${interactionId}, ${randomUUID()}, now() - interval '1 minute', ${principalId}, 'user', 'Canonical observation')`;
    await database`INSERT INTO events (id, occurred_at, source_principal, type, content)
      VALUES (${eventId}, now(), ${principalId}, 'observation', 'Canonical event')`;
    return { interactionId, eventId };
  }

  async function post(url: string) {
    return server.inject({ method: "POST", url, payload: {}, headers: { authorization: `Bearer ${apiKey}` } });
  }

  async function completed(id: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await server.inject({
        method: "GET", url: `/admin/rebuilds/${id}`,
        headers: { authorization: `Bearer ${apiKey}` }
      });
      const status = response.json<{ status: string; errorCode: string | null }>();
      if (status.status !== "processing") return status;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for full rebuild");
  }

  it("keeps old retrieval during staging and atomically activates a new embedding model", async () => {
    const ids = await seedSources();
    expect((await post("/admin/consolidate")).statusCode).toBe(200);
    const old = (await searchMemories(retrieval(), principalId, "observation", 5))[0]!;
    let signal!: () => void;
    const started = new Promise<void>((resolve) => { signal = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    embeddingModel = "new-model";
    derive = async (sources) => {
      signal();
      await blocked;
      return [memory(sources, "Reconstructed interpretation")];
    };

    const accepted = await post("/admin/rebuild");
    expect(accepted.statusCode).toBe(202);
    const rebuildId = accepted.json<{ rebuildId: string }>().rebuildId;
    await started;
    expect((await post("/admin/rebuild")).statusCode).toBe(409);
    const during = await database`SELECT id FROM memories WHERE rebuild_id = ${rebuildId}`;
    expect(during).toHaveLength(0);
    const state = await database<Array<{ active_model_id: string }>>`
      SELECT active_model_id FROM memory_embedding_state`;
    expect(state[0]?.active_model_id).toBe("old-model");
    expect((await searchMemories(retrieval(), principalId, "observation", 5)).map((item) => item.id)).toEqual([old.id]);
    release();
    expect(await completed(rebuildId)).toMatchObject({ status: "succeeded", errorCode: null });

    const active = await database<Array<{ id: string; embedding_model_id: string }>>`
      SELECT id, embedding_model_id FROM memories WHERE rebuild_id = ${rebuildId}`;
    expect(active).toHaveLength(1);
    expect(active[0]?.embedding_model_id).toBe("new-model");
    expect((await searchMemories(retrieval(), principalId, "observation", 5)).map((item) => item.id)).toEqual([active[0]!.id]);
    const lifecycle = await database<Array<{ superseding_run_id: string }>>`
      SELECT superseding_run_id FROM memory_lifecycle_events WHERE memory_id = ${old.id}`;
    expect(lifecycle[0]?.superseding_run_id).toBe(accepted.json().runId);
    expect((await getMemory(database, principalId, old.id))?.lifecycle).toMatchObject({
      status: "superseded", supersedingRunId: accepted.json().runId
    });
    expect(await database`SELECT interaction_id FROM memory_evidence WHERE memory_id = ${old.id}`).toHaveLength(1);
    expect(await database`SELECT event_id FROM memory_event_evidence WHERE memory_id = ${old.id}`).toHaveLength(1);
    expect(await database`SELECT id FROM interactions WHERE id = ${ids.interactionId}`).toHaveLength(1);
    expect(await database`SELECT id FROM events WHERE id = ${ids.eventId}`).toHaveLength(1);
    const timeline = await getMemoryTimeline(database, principalId, { includeDescendants: false, limit: 10 });
    expect(timeline.map((item) => item.id)).toEqual([active[0]!.id]);
  });

  it("hides partial staging and preserves active retrieval on a later batch failure", async () => {
    await server.close();
    server = await createServer(1);
    await seedSources();
    await post("/admin/consolidate");
    let calls = 0;
    embeddingModel = "new-model";
    derive = async (sources) => {
      calls++;
      if (calls > 1) throw new Error("provider unavailable");
      return [memory(sources, "Staged but failed")];
    };
    const accepted = await post("/admin/rebuild");
    const id = accepted.json<{ rebuildId: string }>().rebuildId;
    expect(await completed(id)).toMatchObject({ status: "failed", errorCode: "provider_failure" });
    const staged = await database`SELECT id FROM memories WHERE rebuild_id = ${id}`;
    expect(staged).toHaveLength(1);
    expect(await database`SELECT id FROM memory_lifecycle_events`).toHaveLength(0);
    expect((await searchMemories(retrieval(), principalId, "observation", 5))
      .map((item) => item.content)).toEqual(["Previous interpretation"]);
    expect((await getMemoryTimeline(database, principalId, { includeDescendants: false, limit: 10 }))
      .map((item) => item.content)).toEqual(["Previous interpretation"]);
    expect((await database<Array<{ active_model_id: string }>>`SELECT active_model_id FROM memory_embedding_state`)[0]?.active_model_id).toBe("old-model");
  });

  it("preserves memories citing post-snapshot sources", async () => {
    await server.close();
    server = await createServer(20);
    await seedSources();
    await post("/admin/consolidate");
    embeddingModel = "new-model";
    let signal!: () => void;
    const started = new Promise<void>((resolve) => { signal = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    derive = async (sources) => {
      if (sources.some((source) => source.content === "Late observation")) {
        return [memory(sources, "Late interpretation")];
      }
      signal();
      await blocked;
      return [memory(sources, "Rebuilt interpretation")];
    };
    const accepted = await post("/admin/rebuild");
    const rebuildId = accepted.json<{ rebuildId: string }>().rebuildId;
    await started;
    const lateId = randomUUID();
    await database`INSERT INTO interactions (id, conversation_id, occurred_at, source_principal, role, content)
      VALUES (${lateId}, ${randomUUID()}, now(), ${principalId}, 'user', 'Late observation')`;
    expect((await post("/admin/consolidate")).statusCode).toBe(200);
    const late = await database<Array<{ id: string }>>`SELECT id FROM memories WHERE content = 'Late interpretation'`;
    release();
    expect(await completed(rebuildId)).toMatchObject({ status: "succeeded" });
    expect(await database`SELECT id FROM memory_lifecycle_events WHERE memory_id = ${late[0]!.id}`).toHaveLength(0);
    expect((await getMemoryTimeline(database, principalId, { includeDescendants: false, limit: 10 }))
      .map((item) => item.content).sort()).toEqual(["Late interpretation", "Rebuilt interpretation"]);
  });

  it("marks interrupted staging failed on startup recovery", async () => {
    const runs = await database<Array<{ id: string }>>`
      INSERT INTO consolidation_runs (requested_by, provider, model, consolidator_version,
        status, trigger_kind, source_count)
      VALUES (${principalId}, 'test', 'test', 'test', 'processing', 'full_rebuild', 0) RETURNING id`;
    const rebuilds = await database<Array<{ id: string }>>`
      INSERT INTO memory_rebuilds (consolidation_run_id, requested_by)
      VALUES (${runs[0]!.id}, ${principalId}) RETURNING id`;
    expect(await recoverInterruptedConsolidationRuns(database)).toBe(1);
    const rows = await database<Array<{ status: string; error_code: string }>>`
      SELECT status, error_code FROM memory_rebuilds WHERE id = ${rebuilds[0]!.id}`;
    expect(rows[0]).toMatchObject({ status: "failed", error_code: "interrupted" });
  });

  it("protects rebuild creation and inspection with consolidator authorization", async () => {
    const ordinaryKey = createApiKey();
    await database`INSERT INTO principals (principal_id, api_key_hash)
      VALUES ('client:ordinary', ${hashApiKey(ordinaryKey)})`;
    expect((await server.inject({ method: "POST", url: "/admin/rebuild", payload: {} })).statusCode).toBe(401);
    expect((await server.inject({ method: "POST", url: "/admin/rebuild", payload: {},
      headers: { authorization: `Bearer ${ordinaryKey}` } })).statusCode).toBe(403);
    expect((await server.inject({ method: "GET", url: `/admin/rebuilds/${randomUUID()}`,
      headers: { authorization: `Bearer ${ordinaryKey}` } })).statusCode).toBe(403);
  });
});
