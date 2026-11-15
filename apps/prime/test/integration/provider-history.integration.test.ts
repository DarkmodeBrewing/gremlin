import postgres, { type Sql } from "postgres";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiKey, hashApiKey } from "../../src/auth.js";
import { createProviderHealth } from "../../src/provider-health.js";
import { persistProviderObservation, readProviderHistory } from "../../src/provider-history.js";
import { registerOperationsRoutes } from "../../src/operations.js";
import { buildServer } from "../../src/server.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");

describe("durable provider history", () => {
  let database: Sql;
  const key = createApiKey();
  beforeAll(() => { database = postgres(url, { max: 2 }); });
  beforeEach(async () => {
    await database`TRUNCATE provider_observations`;
    await database`TRUNCATE consolidation_runs, embedding_models, interactions, events, principals CASCADE`;
    await database`INSERT INTO principals (principal_id, api_key_hash, can_consolidate)
      VALUES ('system:consolidator', ${hashApiKey(key)}, true)`;
  });
  afterAll(async () => { await database.end(); });

  async function status(health: ReturnType<typeof createProviderHealth>) {
    const server = await buildServer({ checkDatabase: async () => {}, logLevel: false });
    registerOperationsRoutes(server, database, health);
    try {
      const response = await server.inject({ url: "/admin/operations", headers: { authorization: `Bearer ${key}` } });
      expect(response.statusCode).toBe(200);
      return response.json();
    } finally { await server.close(); }
  }

  it("keeps failure and recovery evidence across fresh monitor/server instances", async () => {
    const persist = (kind: Parameters<typeof persistProviderObservation>[1], observation: Parameters<typeof persistProviderObservation>[2]) => persistProviderObservation(database, kind, observation);
    const failed = createProviderHealth(async () => new Response('private provider error', { status: 401 }), persist);
    await failed.observe("embedding")("https://private.example/secret", { headers: { authorization: 'private-key' } });
    const restarted = createProviderHealth(async () => new Response(null, { status: 200 }), persist);
    const before = await status(restarted);
    expect(before.providers.embedding.status).toBe("not_observed");
    expect(before.providerHistory.latest[0]).toMatchObject({ kind: "embedding", status: "authentication_failed", httpStatus: 401 });
    expect(before.alerts[0].code).toBe("provider_authentication_failed");
    expect(JSON.stringify(before)).not.toContain("private");
    await restarted.observe("embedding")("https://provider.example");
    const after = await status(restarted);
    expect(after.alerts).toEqual([]);
    expect(after.providerHistory.latest[0]).toMatchObject({ status: "ok" });
    expect(after.providerHistory.latest[0].lastFailureAt).not.toBeNull();
    expect(after.providerHistory.latest[0].lastSuccessAt).not.toBeNull();
    expect(after.providerHistory.recent).toHaveLength(2);
  });

  it("reports stalled work after ingestion grace and clears on recorded progress", async () => {
    await database`INSERT INTO interactions (conversation_id, occurred_at, created_at, source_principal, role, content)
      VALUES (${randomUUID()}, now(), now() - interval '1 hour', 'system:consolidator', 'user', 'private pending observation')`;
    const health = createProviderHealth();
    expect((await status(health)).alerts[0].code).toBe("consolidation_stalled");
    await database`INSERT INTO consolidation_runs (requested_by, provider, model, consolidator_version, status, completed_at)
      VALUES ('system:consolidator', 'test', 'test', 'test', 'succeeded', now())`;
    expect((await status(health)).alerts).toEqual([]);
  });

  it("bounds recent history and preserves classification without error text", async () => {
    for (let i = 0; i < 25; i++) await persistProviderObservation(database, "consolidation", {
      status: "rate_limited", observedAt: new Date(Date.now() + i).toISOString(),
      httpStatus: 429, lastSuccessAt: null, lastFailureAt: null
    });
    const history = await readProviderHistory(database);
    expect(history.recent).toHaveLength(20);
    expect(history.latest[0]).toMatchObject({ status: "rate_limited", httpStatus: 429 });
    expect((await database`SELECT count(*)::int count FROM provider_observations`)[0]?.count).toBe(25);
  });
});
