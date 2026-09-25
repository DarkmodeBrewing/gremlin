import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApplication } from "../../src/application.js";
import { createApiKey, hashApiKey } from "../../src/auth.js";
import type { CandidateMemory, ConsolidationSource } from "../../src/consolidation-provider.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required for integration tests");

describe("selective reconstruction", () => {
  let database: Sql;
  let server: FastifyInstance;
  let principalKey: string;
  let candidates: (sources: readonly ConsolidationSource[]) => readonly CandidateMemory[];
  const consolidate = vi.fn(async (sources: readonly ConsolidationSource[]) => candidates(sources));

  beforeAll(async () => {
    database = postgres(databaseUrl, { max: 5 });
    server = await buildApplication({
      database,
      logLevel: false,
      consolidation: {
        batchSize: 20,
        maxSourceCharacters: 200_000,
        provider: { name: "test", model: "test", consolidate },
        embeddingProvider: {
          name: "test", configuredModel: "test",
          embedMany: async (texts) => ({ model: "test", embeddings: texts.map(() => [1, 0, 0]) })
        },
        rateLimit: { maximum: 100, windowMilliseconds: 60_000 }
      }
    });
  });

  beforeEach(async () => {
    await database`TRUNCATE consolidation_runs, embedding_models, events, interactions, principals CASCADE`;
    principalKey = createApiKey();
    await database`INSERT INTO principals (principal_id, api_key_hash, can_consolidate)
      VALUES ('system:consolidator', ${hashApiKey(principalKey)}, true)`;
    candidates = (sources) => [{
      namespace: "projects/gremlin", content: "Original interpretation", confidence: 0.9,
      evidence: sources.map((source) => ({ kind: source.kind, id: source.id }))
    }];
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await server.close();
    await database.end({ timeout: 5 });
  });

  async function sources(): Promise<{ interactionId: string; eventId: string }> {
    const interactionId = randomUUID();
    const eventId = randomUUID();
    await database`INSERT INTO interactions (id, conversation_id, occurred_at, source_principal, role, content)
      VALUES (${interactionId}, ${randomUUID()}, now(), 'system:consolidator', 'user', 'Source observation')`;
    await database`INSERT INTO events (id, occurred_at, source_principal, type, content)
      VALUES (${eventId}, now(), 'system:consolidator', 'observation', 'Event observation')`;
    return { interactionId, eventId };
  }

  const refs = (ids: { interactionId: string; eventId: string }) => [
    { kind: "interaction", id: ids.interactionId }, { kind: "event", id: ids.eventId }
  ];
  async function request(url: string, payload: object, key = principalKey) {
    return server.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${key}` } });
  }

  it("atomically supersedes only fully selected evidence and retains canonical rows", async () => {
    const ids = await sources();
    expect((await request("/admin/consolidate", {})).statusCode).toBe(200);
    const original = await database<Array<{ id: string }>>`SELECT id FROM memories`;

    candidates = (batch) => [{
      namespace: "projects/gremlin", content: "Corrected interpretation", confidence: 0.95,
      evidence: batch.map((source) => ({ kind: source.kind, id: source.id }))
    }];
    const partial = await request("/admin/reconstruct", { sources: [refs(ids)[0]] });
    expect(partial.statusCode).toBe(200);
    expect(partial.json()).toMatchObject({ sourceCount: 1, memoryCount: 1 });
    expect(await database`SELECT id FROM memory_lifecycle_events`).toHaveLength(0);
    const partialMemory = await database<Array<{ id: string }>>`
      SELECT id FROM memories WHERE consolidation_run_id = ${partial.json().runId}`;

    const full = await request("/admin/reconstruct", { sources: refs(ids) });
    expect(full.statusCode).toBe(200);
    const events = await database<Array<{ memory_id: string; superseding_run_id: string }>>`
      SELECT memory_id, superseding_run_id FROM memory_lifecycle_events ORDER BY memory_id`;
    expect(events.map((event) => event.memory_id).sort()).toEqual(
      [original[0]!.id, partialMemory[0]!.id].sort()
    );
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.superseding_run_id === full.json().runId)).toBe(true);
    expect(await database`SELECT id FROM interactions WHERE id = ${ids.interactionId}`).toHaveLength(1);
    expect(await database`SELECT id FROM events WHERE id = ${ids.eventId}`).toHaveLength(1);
    expect(await database`SELECT interaction_id FROM memory_evidence WHERE memory_id = ${original[0]!.id}`).toHaveLength(1);
    expect(await database`SELECT event_id FROM memory_event_evidence WHERE memory_id = ${original[0]!.id}`).toHaveLength(1);
  });

  it("deduplicates an exact active candidate and keeps it active", async () => {
    const ids = await sources();
    await request("/admin/consolidate", {});
    const response = await request("/admin/reconstruct", { sources: refs(ids) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ memoryCount: 0, sourceCount: 2 });
    expect(await database`SELECT id FROM memories`).toHaveLength(1);
    expect(await database`SELECT id FROM memory_lifecycle_events`).toHaveLength(0);
    expect(await database`SELECT run_id FROM consolidation_run_sources WHERE interaction_id = ${ids.interactionId}`).toHaveLength(2);
  });

  it("preserves active memories when generation fails or yields no replacement", async () => {
    const ids = await sources();
    await request("/admin/consolidate", {});
    candidates = () => { throw new Error("provider failed"); };
    const failed = await request("/admin/reconstruct", { sources: refs(ids) });
    expect(failed.statusCode).toBe(502);
    expect(await database`SELECT id FROM memory_lifecycle_events`).toHaveLength(0);
    candidates = () => [];
    const empty = await request("/admin/reconstruct", { sources: refs(ids) });
    expect(empty.statusCode).toBe(200);
    expect(await database`SELECT id FROM memory_lifecycle_events`).toHaveLength(0);
  });

  it("rejects missing, duplicate, and unauthorized source requests", async () => {
    const ids = await sources();
    const otherKey = createApiKey();
    await database`INSERT INTO principals (principal_id, api_key_hash)
      VALUES ('client:ordinary', ${hashApiKey(otherKey)})`;
    expect((await request("/admin/reconstruct", { sources: refs(ids) }, otherKey)).statusCode).toBe(403);
    expect((await request("/admin/reconstruct", { sources: [refs(ids)[0], refs(ids)[0]] })).statusCode).toBe(400);
    expect((await request("/admin/reconstruct", { sources: [{ kind: "event", id: randomUUID() }] })).statusCode).toBe(409);
    expect(consolidate).not.toHaveBeenCalled();
  });
});
