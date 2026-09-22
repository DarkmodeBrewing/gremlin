import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApiKey, hashApiKey } from "../../src/auth.js";
import { exportCanonicalSources } from "../../src/source-export.js";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for integration tests");
}

function parseJsonLines(content: string): Array<Record<string, unknown>> {
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("canonical source export", () => {
  let database: Sql;
  let temporaryRoot: string;

  beforeAll(() => {
    database = postgres(databaseUrl, { max: 2 });
  });

  beforeEach(async () => {
    await database`TRUNCATE interactions, events, principals CASCADE`;
    temporaryRoot = await mkdtemp(join(tmpdir(), "gremlin-source-export-"));
  });

  afterEach(async () => {
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  afterAll(async () => {
    await database.end({ timeout: 5 });
  });

  it("exports complete deterministic JSONL with canonical provenance", async () => {
    const principalId = "client:gremlin-chat";
    const apiKey = createApiKey();

    await database`
      INSERT INTO principals (
        principal_id,
        api_key_hash,
        can_ingest_interactions,
        can_ingest_events
      )
      VALUES (${principalId}, ${hashApiKey(apiKey)}, true, true)
    `;

    await database`
      INSERT INTO interactions (
        conversation_id,
        occurred_at,
        created_at,
        source_principal,
        role,
        content,
        metadata
      )
      SELECT
        uuidv7(),
        '2026-09-22T08:00:00Z'::timestamptz + source.offset * interval '1 second',
        '2026-09-22T09:00:00Z'::timestamptz + source.offset * interval '1 millisecond',
        ${principalId},
        CASE WHEN source.offset % 2 = 0 THEN 'user' ELSE 'assistant' END,
        'canonical interaction ' || source.offset,
        jsonb_build_object('sequence', source.offset)
      FROM generate_series(0, 500) AS source(offset)
    `;

    await database`
      INSERT INTO events (
        occurred_at,
        created_at,
        source_principal,
        type,
        content,
        metadata
      )
      VALUES (
        '2026-09-22T10:00:00Z',
        '2026-09-22T10:00:01Z',
        ${principalId},
        'service.deployed',
        'Gremlin M7 entered production.',
        ${database.json({ environment: "production" })}
      )
    `;

    const outputDirectory = join(temporaryRoot, "snapshot");
    const result = await exportCanonicalSources(database, outputDirectory);
    const interactions = parseJsonLines(
      await readFile(result.interactionsPath, "utf8")
    );
    const events = parseJsonLines(await readFile(result.eventsPath, "utf8"));

    expect(result).toMatchObject({ events: 1, interactions: 501 });
    expect(interactions).toHaveLength(501);
    expect(interactions[0]).toMatchObject({
      schemaVersion: 1,
      timestamp: "2026-09-22T08:00:00.000Z",
      createdAt: "2026-09-22T09:00:00.000Z",
      sourcePrincipal: principalId,
      role: "user",
      content: "canonical interaction 0",
      metadata: { sequence: 0 }
    });
    expect(interactions[500]).toMatchObject({
      timestamp: "2026-09-22T08:08:20.000Z",
      createdAt: "2026-09-22T09:00:00.500Z",
      sourcePrincipal: principalId,
      content: "canonical interaction 500",
      metadata: { sequence: 500 }
    });
    expect(interactions[0]).toHaveProperty("id");
    expect(interactions[0]).toHaveProperty("conversationId");

    expect(events).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        timestamp: "2026-09-22T10:00:00.000Z",
        createdAt: "2026-09-22T10:00:01.000Z",
        sourcePrincipal: principalId,
        type: "service.deployed",
        content: "Gremlin M7 entered production.",
        metadata: { environment: "production" }
      })
    ]);

    expect((await stat(result.interactionsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(result.eventsPath)).mode & 0o777).toBe(0o600);
    await expect(
      exportCanonicalSources(database, outputDirectory)
    ).rejects.toThrow();
  });
});
