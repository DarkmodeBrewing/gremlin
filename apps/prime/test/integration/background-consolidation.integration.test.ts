import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  consolidateInteractions,
  recoverInterruptedConsolidationRuns,
  type ConsolidationDependencies
} from "../../src/consolidation.js";
import { runBackgroundConsolidationOnce } from "../../src/consolidation-worker.js";
import type { ConsolidationSource } from "../../src/consolidation-provider.js";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for integration tests");
}

describe("background consolidation", () => {
  let database: Sql;
  let dependencies: ConsolidationDependencies;
  let observedSources: readonly ConsolidationSource[] = [];
  const logger = { error: vi.fn(), info: vi.fn() };
  const options = {
    maxAttempts: 3,
    pollIntervalMilliseconds: 60_000,
    principalId: "system:consolidator",
    retryDelayMilliseconds: 300_000
  };

  beforeAll(() => {
    database = postgres(databaseUrl, { max: 5 });
  });

  beforeEach(async () => {
    await database`
      TRUNCATE consolidation_runs, embedding_models, events, interactions, principals CASCADE
    `;
    await database`
      INSERT INTO principals (principal_id, api_key_hash, can_consolidate)
      VALUES ('system:consolidator', ${"a".repeat(64)}, true)
    `;
    observedSources = [];
    vi.clearAllMocks();
    dependencies = {
      batchSize: 20,
      database,
      embeddingProvider: {
        configuredModel: "test-embedding",
        embedMany: async (texts) => ({
          embeddings: texts.map(() => [0.1, 0.2, 0.3]),
          model: "test-embedding"
        }),
        name: "test-embedding"
      },
      maxSourceCharacters: 200_000,
      provider: {
        consolidate: async (sources) => {
          observedSources = sources;
          return [
            {
              confidence: 0.95,
              content: "Background consolidation combines canonical sources.",
              evidence: sources.map((source) => ({
                kind: source.kind,
                id: source.id
              })),
              namespace: "projects/gremlin"
            }
          ];
        },
        model: "test-consolidator",
        name: "test-consolidation"
      }
    };
  });

  afterAll(async () => {
    await database.end({ timeout: 5 });
  });

  async function insertCanonicalSources(): Promise<{
    eventId: string;
    interactionId: string;
  }> {
    const interactionId = randomUUID();
    const eventId = randomUUID();
    await database`
      INSERT INTO interactions (id, conversation_id, occurred_at, source_principal, role, content)
      VALUES (${interactionId}, ${randomUUID()}, now() - interval '1 minute', 'system:consolidator', 'user', 'Interaction source')
    `;
    await database`
      INSERT INTO events (id, occurred_at, source_principal, type, content)
      VALUES (${eventId}, now(), 'system:consolidator', 'deploy.completed', 'Event source')
    `;
    return { eventId, interactionId };
  }

  it("claims interactions and events once and persists both evidence kinds", async () => {
    const ids = await insertCanonicalSources();

    const result = await runBackgroundConsolidationOnce(
      dependencies,
      options,
      logger
    );

    expect(result).toMatchObject({ memoryCount: 1, sourceCount: 2 });
    expect(observedSources.map((source) => source.kind)).toEqual([
      "interaction",
      "event"
    ]);
    const rows = await database<
      Array<{
        event_ids: string[];
        interaction_ids: string[];
        trigger_kind: string;
      }>
    >`
      SELECT
        run.trigger_kind,
        ARRAY(SELECT event_id::text FROM memory_event_evidence WHERE memory_id = memory.id) AS event_ids,
        ARRAY(SELECT interaction_id::text FROM memory_evidence WHERE memory_id = memory.id) AS interaction_ids
      FROM memories memory
      JOIN consolidation_runs run ON run.id = memory.consolidation_run_id
    `;
    expect(rows).toEqual([
      {
        event_ids: [ids.eventId],
        interaction_ids: [ids.interactionId],
        trigger_kind: "background"
      }
    ]);

    await expect(
      runBackgroundConsolidationOnce(dependencies, options, logger)
    ).resolves.toBeNull();
    const runCount = await database<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM consolidation_runs
    `;
    expect(runCount[0]?.count).toBe(1);
  });

  it("honors retry cooldown while retaining the manual recovery path", async () => {
    await insertCanonicalSources();
    dependencies = {
      ...dependencies,
      provider: {
        ...dependencies.provider,
        consolidate: async () => {
          throw new Error("provider unavailable");
        }
      }
    };

    await expect(
      runBackgroundConsolidationOnce(dependencies, options, logger)
    ).resolves.toBeNull();
    await expect(
      runBackgroundConsolidationOnce(dependencies, options, logger)
    ).resolves.toBeNull();
    const failedRuns = await database<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM consolidation_runs WHERE status = 'failed'
    `;
    expect(failedRuns[0]?.count).toBe(1);

    dependencies = {
      ...dependencies,
      provider: {
        ...dependencies.provider,
        consolidate: async () => []
      }
    };
    await expect(
      consolidateInteractions(dependencies, options.principalId)
    ).resolves.toMatchObject({ sourceCount: 2, status: "succeeded" });
  });

  it("stops automatic retries at the configured attempt limit", async () => {
    await insertCanonicalSources();
    dependencies = {
      ...dependencies,
      provider: {
        ...dependencies.provider,
        consolidate: async () => {
          throw new Error("provider unavailable");
        }
      }
    };
    const limitedOptions = {
      ...options,
      maxAttempts: 2,
      retryDelayMilliseconds: 0
    };

    await runBackgroundConsolidationOnce(dependencies, limitedOptions, logger);
    await runBackgroundConsolidationOnce(dependencies, limitedOptions, logger);
    await runBackgroundConsolidationOnce(dependencies, limitedOptions, logger);

    const failedRuns = await database<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM consolidation_runs WHERE status = 'failed'
    `;
    expect(failedRuns[0]?.count).toBe(2);
  });

  it("marks interrupted work failed so it can be retried", async () => {
    const { interactionId } = await insertCanonicalSources();
    const runs = await database<Array<{ id: string }>>`
      INSERT INTO consolidation_runs (requested_by, provider, model, consolidator_version, status, source_count, trigger_kind)
      VALUES ('system:consolidator', 'test', 'test', 'test', 'processing', 1, 'background')
      RETURNING id
    `;
    await database`
      INSERT INTO consolidation_run_sources (run_id, interaction_id, status)
      VALUES (${runs[0]!.id}, ${interactionId}, 'processing')
    `;

    await expect(recoverInterruptedConsolidationRuns(database)).resolves.toBe(1);
    const recovered = await database<
      Array<{ error_code: string; source_status: string; status: string }>
    >`
      SELECT run.status, run.error_code, source.status AS source_status
      FROM consolidation_runs run
      JOIN consolidation_run_sources source ON source.run_id = run.id
    `;
    expect(recovered).toEqual([
      { error_code: "interrupted", source_status: "failed", status: "failed" }
    ]);
  });
});
