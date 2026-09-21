import type { FastifyInstance } from "fastify";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../../src/application.js";
import { createApiKey, hashApiKey } from "../../src/auth.js";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for integration tests");
}

describe("event archive", () => {
  let database: Sql;
  let server: FastifyInstance;

  beforeAll(async () => {
    database = postgres(databaseUrl, { max: 5 });
    server = await buildApplication({
      consolidation: {
        batchSize: 20,
        embeddingProvider: {
          configuredModel: "unused",
          embedMany: async () => ({ embeddings: [], model: "unused" }),
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
  });

  beforeEach(async () => {
    await database`TRUNCATE events, principals CASCADE`;
  });

  afterAll(async () => {
    await server.close();
    await database.end({ timeout: 5 });
  });

  async function registerPrincipal(
    id: string,
    canIngestEvents: boolean
  ): Promise<string> {
    const apiKey = createApiKey();

    await database`
      INSERT INTO principals (principal_id, api_key_hash, can_ingest_events)
      VALUES (${id}, ${hashApiKey(apiKey)}, ${canIngestEvents})
    `;
    return apiKey;
  }

  it("persists an append-only event with authenticated provenance", async () => {
    const principalId = "agent:opencode";
    const apiKey = await registerPrincipal(principalId, true);
    const payload = {
      content: "Gremlin M6 entered production.",
      metadata: { environment: "production" },
      timestamp: new Date().toISOString(),
      type: "service.deployed"
    };

    const response = await server.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ ...payload, sourcePrincipal: principalId });
  });

  it("requires event-ingestion permission and rejects supplied identity", async () => {
    const readOnlyApiKey = await registerPrincipal("agent:read-only", false);
    const ingestApiKey = await registerPrincipal("agent:opencode", true);
    const payload = {
      content: "Must not persist.",
      timestamp: new Date().toISOString(),
      type: "manual.note"
    };

    const forbiddenResponse = await server.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${readOnlyApiKey}` },
      payload
    });
    const spoofedResponse = await server.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${ingestApiKey}` },
      payload: { ...payload, sourcePrincipal: "system:consolidator" }
    });

    expect(forbiddenResponse.statusCode).toBe(403);
    expect(spoofedResponse.statusCode).toBe(400);
    const rows = await database<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM events
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it("returns events only to their source principal", async () => {
    const sourceApiKey = await registerPrincipal("agent:opencode", true);
    const otherApiKey = await registerPrincipal("agent:hermes", true);
    const createResponse = await server.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${sourceApiKey}` },
      payload: {
        content: "A private project event.",
        timestamp: new Date().toISOString(),
        type: "project.created"
      }
    });
    const eventId = createResponse.json<{ id: string }>().id;

    const ownResponse = await server.inject({
      method: "GET",
      url: `/events/${eventId}`,
      headers: { authorization: `Bearer ${sourceApiKey}` }
    });
    const otherResponse = await server.inject({
      method: "GET",
      url: `/events/${eventId}`,
      headers: { authorization: `Bearer ${otherApiKey}` }
    });

    expect(ownResponse.statusCode).toBe(200);
    expect(otherResponse.statusCode).toBe(404);
  });
});
