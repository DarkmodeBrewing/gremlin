import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApplication } from "../../src/application.js";
import { createApiKey, hashApiKey } from "../../src/auth.js";
import { createOpenRouterConsolidationProvider } from "../../src/consolidation-provider.js";
import { registerOperationsRoutes } from "../../src/operations.js";
import { createProviderHealth } from "../../src/provider-health.js";
import { buildServer } from "../../src/server.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required for integration tests");

describe("operations status", () => {
  let database: Sql;
  let server: FastifyInstance;
  const admin = createApiKey();
  const ordinary = createApiKey();
  const providerRequest = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
  const health = createProviderHealth(providerRequest);
  const authorization = { authorization: `Bearer ${admin}` };

  beforeAll(async () => {
    database = postgres(databaseUrl, { max: 2 });
    server = await buildApplication({
      database, logLevel: false, providerHealth: health,
      consolidation: {
        batchSize: 20, maxSourceCharacters: 200_000,
        provider: createOpenRouterConsolidationProvider({ apiKey: "test-only", model: "test",
          timeoutMilliseconds: 1000, fetchImplementation: health.observe("consolidation") }),
        embeddingProvider: { name: "test", configuredModel: "test", embedMany: async () => ({ model: "test", embeddings: [] }) }
      }
    });
  });
  beforeEach(async () => {
    await database`TRUNCATE provider_observations`;
    await database`TRUNCATE consolidation_runs, embedding_models, interactions, events, principals CASCADE`;
    await database`INSERT INTO principals (principal_id, api_key_hash, can_consolidate) VALUES
      ('system:consolidator', ${hashApiKey(admin)}, true), ('client:ordinary', ${hashApiKey(ordinary)}, false)`;
    providerRequest.mockClear();
  });
  afterAll(async () => { await server.close(); await database.end(); });

  it("requires consolidator authorization and does not disclose status to ordinary clients", async () => {
    expect((await server.inject({ url: "/admin/operations" })).statusCode).toBe(401);
    const response = await server.inject({ url: "/admin/operations", headers: { authorization: `Bearer ${ordinary}` } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
    expect(providerRequest).not.toHaveBeenCalled();
  });

  it("reports empty state and sanitized provider authentication failures without probing", async () => {
    await health.observe("embedding")("https://provider.example");
    providerRequest.mockClear();
    const response = await server.inject({ url: "/admin/operations", headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      providers: { embedding: { status: "authentication_failed", httpStatus: 401 } },
      consolidation: { backlog: 0, lastSuccessfulRunAt: null, recentRuns: [], runs: { failed: 0, succeeded: 0, processing: 0 } }
    });
    expect(providerRequest).not.toHaveBeenCalled();
    expect(response.body).not.toContain(admin);
    expect((await server.inject({ url: "/health" })).statusCode).toBe(200);
  });

  it("exposes a real consolidation HTTP failure while database health stays ok", async () => {
    await database`INSERT INTO interactions (id, conversation_id, occurred_at, source_principal, role, content)
      VALUES (${randomUUID()}, ${randomUUID()}, now(), 'system:consolidator', 'user', 'private observation')`;
    const failed = await server.inject({ method: "POST", url: "/admin/consolidate", payload: {}, headers: authorization });
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    const response = await server.inject({ url: "/admin/operations", headers: authorization });
    expect(response.json()).toMatchObject({
      providers: { consolidation: { status: "authentication_failed", httpStatus: 401 } },
      consolidation: { backlog: 1, sources: { failed: 1 }, runs: { failed: 1 } }
    });
    expect((await server.inject({ url: "/health" })).statusCode).toBe(200);
    expect(response.body).not.toContain("private");
    expect(response.body).not.toContain("test-only");
  });

  it("counts distinct unresolved sources and finds the last successful run", async () => {
    const interactions = [randomUUID(), randomUUID(), randomUUID()];
    const events = [randomUUID(), randomUUID()];
    for (const id of interactions) await database`INSERT INTO interactions
      (id, conversation_id, occurred_at, source_principal, role, content)
      VALUES (${id}, ${randomUUID()}, now(), 'system:consolidator', 'user', 'private source body')`;
    for (const id of events) await database`INSERT INTO events (id, occurred_at, source_principal, type, content)
      VALUES (${id}, now(), 'system:consolidator', 'test', 'private event body')`;
    const runIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < runIds.length; i++) {
      const status = i < 2 ? "failed" : i === 2 ? "succeeded" : "processing";
      await database`INSERT INTO consolidation_runs
        (id, requested_by, provider, model, consolidator_version, status, error_code, completed_at)
        VALUES (${runIds[i]!}, 'system:consolidator', 'test', 'test', 'test', ${status},
          ${status === "failed" ? "provider_failure" : null}, ${status === "processing" ? null : new Date("2026-11-15T10:00:00Z")})`;
    }
    for (const run of runIds.slice(0, 2)) await database`INSERT INTO consolidation_run_sources
      (run_id, interaction_id, status, completed_at) VALUES (${run!}, ${interactions[1]!}, 'failed', now())`;
    await database`INSERT INTO consolidation_run_sources (run_id, interaction_id, status, completed_at)
      VALUES (${runIds[0]!}, ${interactions[2]!}, 'failed', now()), (${runIds[2]!}, ${interactions[2]!}, 'succeeded', now())`;
    await database`INSERT INTO consolidation_run_event_sources (run_id, event_id) VALUES (${runIds[3]!}, ${events[0]!})`;
    const response = await server.inject({ url: "/admin/operations", headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(response.json().consolidation).toMatchObject({
      backlog: 3, sources: { pending: 2, failed: 1, succeeded: 1, processing: 1 },
      runs: { failed: 2, succeeded: 1, processing: 1 }, lastSuccessfulRunAt: "2026-11-15T10:00:00.000Z"
    });
    expect(response.body).not.toContain("private");
    expect(providerRequest).not.toHaveBeenCalled();
  });

  it("enforces rate limiting before authentication", async () => {
    const limited = await buildServer({ checkDatabase: async () => {}, logLevel: false,
      rateLimit: { maximum: 2, windowMilliseconds: 60_000 } });
    registerOperationsRoutes(limited, database, health);
    try {
      expect((await limited.inject({ url: "/admin/operations" })).statusCode).toBe(401);
      expect((await limited.inject({ url: "/admin/operations" })).statusCode).toBe(401);
      const response = await limited.inject({ url: "/admin/operations" });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({ error: "rate_limit_exceeded" });
    } finally { await limited.close(); }
  });
});
