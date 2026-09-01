import { randomUUID } from "node:crypto";

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

describe("interaction archive", () => {
  let database: Sql;
  let server: FastifyInstance;

  beforeAll(async () => {
    database = postgres(databaseUrl, { max: 5 });
    server = await buildApplication({ database, logLevel: false });
  });

  beforeEach(async () => {
    await database`TRUNCATE interactions, principals CASCADE`;
  });

  afterAll(async () => {
    await server.close();
    await database.end({ timeout: 5 });
  });

  async function registerPrincipal(
    id: string,
    canIngestInteractions = true
  ): Promise<RegisteredPrincipal> {
    const apiKey = createApiKey();

    await database`
      INSERT INTO principals (
        principal_id,
        api_key_hash,
        can_ingest_interactions
      )
      VALUES (
        ${id},
        ${hashApiKey(apiKey)},
        ${canIngestInteractions}
      )
    `;

    return { apiKey, id };
  }

  function interactionPayload(): Record<string, unknown> {
    return {
      content: "M2 archives this interaction without changing it.",
      conversationId: randomUUID(),
      metadata: { model: "integration-model", provider: "integration-provider" },
      role: "user",
      timestamp: new Date().toISOString()
    };
  }

  it("derives source identity from the API key and persists provenance", async () => {
    const principal = await registerPrincipal("client:gremlin-chat");
    const payload = interactionPayload();

    const response = await server.inject({
      method: "POST",
      url: "/interactions",
      headers: { authorization: `Bearer ${principal.apiKey}` },
      payload
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      ...payload,
      sourcePrincipal: principal.id
    });
    expect(response.json<{ id: string }>().id.split("-")[2]?.startsWith("7")).toBe(
      true
    );

    const rows = await database<
      Array<{ api_key_hash: string; content: string; source_principal: string }>
    >`
      SELECT p.api_key_hash, i.content, i.source_principal
      FROM interactions i
      JOIN principals p ON p.principal_id = i.source_principal
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content: payload.content,
      source_principal: principal.id
    });
    expect(rows[0]?.api_key_hash).not.toBe(principal.apiKey);
  });

  it("rejects request-supplied source identity", async () => {
    const principal = await registerPrincipal("agent:opencode");

    const response = await server.inject({
      method: "POST",
      url: "/interactions",
      headers: { authorization: `Bearer ${principal.apiKey}` },
      payload: {
        ...interactionPayload(),
        sourcePrincipal: "system:consolidator"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });

    const countRows = await database<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM interactions
    `;
    expect(countRows[0]?.count).toBe(0);
  });

  it("requires authentication and interaction-ingestion permission", async () => {
    const unprivileged = await registerPrincipal("agent:read-only", false);
    const payload = interactionPayload();

    const unauthenticatedResponse = await server.inject({
      method: "POST",
      url: "/interactions",
      payload
    });
    const forbiddenResponse = await server.inject({
      method: "POST",
      url: "/interactions",
      headers: { authorization: `Bearer ${unprivileged.apiKey}` },
      payload
    });

    expect(unauthenticatedResponse.statusCode).toBe(401);
    expect(unauthenticatedResponse.headers["www-authenticate"]).toBe("Bearer");
    expect(forbiddenResponse.statusCode).toBe(403);
  });

  it("returns an interaction only to its source principal", async () => {
    const source = await registerPrincipal("client:gremlin-chat");
    const other = await registerPrincipal("agent:opencode");
    const createResponse = await server.inject({
      method: "POST",
      url: "/interactions",
      headers: { authorization: `Bearer ${source.apiKey}` },
      payload: interactionPayload()
    });
    const interactionId = createResponse.json<{ id: string }>().id;

    const ownResponse = await server.inject({
      method: "GET",
      url: `/interactions/${interactionId}`,
      headers: { authorization: `Bearer ${source.apiKey}` }
    });
    const otherResponse = await server.inject({
      method: "GET",
      url: `/interactions/${interactionId}`,
      headers: { authorization: `Bearer ${other.apiKey}` }
    });

    expect(ownResponse.statusCode).toBe(200);
    expect(ownResponse.json()).toMatchObject({
      id: interactionId,
      sourcePrincipal: source.id
    });
    expect(otherResponse.statusCode).toBe(404);
  });

  it("rejects metadata that could persist credentials", async () => {
    const principal = await registerPrincipal("agent:hermes");

    const response = await server.inject({
      method: "POST",
      url: "/interactions",
      headers: { authorization: `Bearer ${principal.apiKey}` },
      payload: {
        ...interactionPayload(),
        metadata: { authorization: true }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "invalid_request",
      fields: ["metadata"]
    });
  });
});
