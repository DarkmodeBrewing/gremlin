import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../../src/application.js";
import { createApiKey, hashApiKey } from "../../src/auth.js";
import {
  PrincipalKeyRotationError,
  rotatePrincipalApiKey
} from "../../src/principal-credentials.js";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for integration tests");
}

describe("principal API-key rotation", () => {
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
    await database`TRUNCATE principals CASCADE`;
  });

  afterAll(async () => {
    await server.close();
    await database.end({ timeout: 5 });
  });

  it("activates the replacement and immediately invalidates the old key", async () => {
    const principalId = "agent:opencode";
    const oldApiKey = createApiKey();

    await database`
      INSERT INTO principals (
        principal_id,
        api_key_hash,
        can_ingest_interactions
      )
      VALUES (${principalId}, ${hashApiKey(oldApiKey)}, true)
    `;

    const newApiKey = await rotatePrincipalApiKey(database, principalId);
    const interactionId = randomUUID();
    const oldKeyResponse = await server.inject({
      method: "GET",
      url: `/interactions/${interactionId}`,
      headers: { authorization: `Bearer ${oldApiKey}` }
    });
    const newKeyResponse = await server.inject({
      method: "GET",
      url: `/interactions/${interactionId}`,
      headers: { authorization: `Bearer ${newApiKey}` }
    });
    const rows = await database<Array<{ api_key_hash: string }>>`
      SELECT api_key_hash
      FROM principals
      WHERE principal_id = ${principalId}
    `;

    expect(newApiKey).not.toBe(oldApiKey);
    expect(oldKeyResponse.statusCode).toBe(401);
    expect(newKeyResponse.statusCode).toBe(404);
    expect(rows[0]?.api_key_hash).toBe(hashApiKey(newApiKey));
    expect(rows[0]?.api_key_hash).not.toContain(newApiKey);
  });

  it("does not issue a usable replacement for an inactive principal", async () => {
    const principalId = "agent:inactive";
    const oldApiKey = createApiKey();

    await database`
      INSERT INTO principals (principal_id, api_key_hash, active)
      VALUES (${principalId}, ${hashApiKey(oldApiKey)}, false)
    `;

    await expect(rotatePrincipalApiKey(database, principalId)).rejects.toBeInstanceOf(
      PrincipalKeyRotationError
    );

    const rows = await database<Array<{ api_key_hash: string }>>`
      SELECT api_key_hash
      FROM principals
      WHERE principal_id = ${principalId}
    `;
    expect(rows[0]?.api_key_hash).toBe(hashApiKey(oldApiKey));
  });
});
