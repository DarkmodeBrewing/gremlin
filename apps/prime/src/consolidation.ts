import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { authenticatePrincipal } from "./auth.js";
import {
  ConsolidationProviderError,
  type CandidateMemory,
  type ConsolidationProvider,
  type SourceInteraction
} from "./consolidation-provider.js";
import type { Database } from "./database.js";
import {
  EmbeddingProviderError,
  type EmbeddingProvider
} from "./embedding-provider.js";

const consolidatorVersion = "gremlin-consolidator-v1";
const requestBodySchema = z.object({}).strict().optional();

type SourceInteractionRow = Readonly<{
  content: string;
  conversation_id: string;
  id: string;
  occurred_at: Date;
  role: SourceInteraction["role"];
  source_principal: string;
}>;

type RunRow = Readonly<{ id: string }>;

type ClaimedBatch = Readonly<{
  interactions: readonly SourceInteraction[];
  runId: string;
}>;

export type ConsolidationResult = Readonly<{
  memoryCount: number;
  runId: string;
  sourceCount: number;
  status: "succeeded";
}>;

export type ConsolidationDependencies = Readonly<{
  batchSize: number;
  database: Database;
  embeddingProvider: EmbeddingProvider;
  maxSourceCharacters: number;
  provider: ConsolidationProvider;
}>;

export class ConsolidationExecutionError extends Error {
  readonly code: string;
  readonly runId: string;

  constructor(code: string, runId: string) {
    super(`Consolidation run ${runId} failed: ${code}`);
    this.name = "ConsolidationExecutionError";
    this.code = code;
    this.runId = runId;
  }
}

function serializeSource(row: SourceInteractionRow): SourceInteraction {
  return {
    content: row.content,
    conversationId: row.conversation_id,
    id: row.id,
    occurredAt: row.occurred_at,
    role: row.role,
    sourcePrincipal: row.source_principal
  };
}

function limitSourceCharacters(
  rows: readonly SourceInteractionRow[],
  maximumCharacters: number
): readonly SourceInteractionRow[] {
  const selected: SourceInteractionRow[] = [];
  let characterCount = 0;

  for (const row of rows) {
    if (
      selected.length > 0 &&
      characterCount + row.content.length > maximumCharacters
    ) {
      break;
    }

    selected.push(row);
    characterCount += row.content.length;
  }

  return selected;
}

async function claimBatch(
  dependencies: ConsolidationDependencies,
  requestedBy: string
): Promise<ClaimedBatch> {
  return dependencies.database.begin(async (transaction) => {
    const runRows = await transaction<RunRow[]>`
      INSERT INTO consolidation_runs (
        requested_by,
        provider,
        model,
        consolidator_version,
        status
      )
      VALUES (
        ${requestedBy},
        ${dependencies.provider.name},
        ${dependencies.provider.model},
        ${consolidatorVersion},
        'processing'
      )
      RETURNING id
    `;
    const run = runRows[0];

    if (run === undefined) {
      throw new Error("Consolidation run insert returned no record");
    }

    const candidateRows = await transaction<SourceInteractionRow[]>`
      SELECT
        i.id,
        i.conversation_id,
        i.occurred_at,
        i.source_principal,
        i.role,
        i.content
      FROM interactions i
      WHERE NOT EXISTS (
        SELECT 1
        FROM consolidation_run_sources source
        WHERE source.interaction_id = i.id
          AND source.status IN ('processing', 'succeeded')
      )
      ORDER BY i.occurred_at, i.id
      LIMIT ${dependencies.batchSize}
      FOR UPDATE OF i SKIP LOCKED
    `;
    const selectedRows = limitSourceCharacters(
      candidateRows,
      dependencies.maxSourceCharacters
    );

    for (const source of selectedRows) {
      await transaction`
        INSERT INTO consolidation_run_sources (
          run_id,
          interaction_id,
          status
        )
        VALUES (${run.id}, ${source.id}, 'processing')
      `;
    }

    if (selectedRows.length === 0) {
      await transaction`
        UPDATE consolidation_runs
        SET status = 'succeeded', completed_at = now()
        WHERE id = ${run.id}
      `;
    } else {
      await transaction`
        UPDATE consolidation_runs
        SET source_count = ${selectedRows.length}
        WHERE id = ${run.id}
      `;
    }

    return {
      interactions: selectedRows.map(serializeSource),
      runId: run.id
    };
  });
}

function validateEvidence(
  candidates: readonly CandidateMemory[],
  interactions: readonly SourceInteraction[]
): void {
  const sourceIds = new Set(interactions.map((interaction) => interaction.id));

  for (const candidate of candidates) {
    if (
      candidate.evidenceInteractionIds.some(
        (interactionId) => !sourceIds.has(interactionId)
      )
    ) {
      throw new ConsolidationProviderError(
        "Consolidation output referenced evidence outside the source batch"
      );
    }
  }
}

function validateEmbeddings(
  embeddings: readonly (readonly number[])[],
  expectedCount: number
): number {
  const dimensions = embeddings[0]?.length;

  if (
    embeddings.length !== expectedCount ||
    dimensions === undefined ||
    dimensions === 0 ||
    embeddings.some(
      (embedding) =>
        embedding.length !== dimensions ||
        embedding.some((value) => !Number.isFinite(value))
    )
  ) {
    throw new EmbeddingProviderError(
      "Embedding provider returned an invalid embedding batch"
    );
  }

  return dimensions;
}

async function markRunFailed(
  database: Database,
  runId: string,
  errorCode: string
): Promise<void> {
  await database.begin(async (transaction) => {
    await transaction`
      UPDATE consolidation_run_sources
      SET status = 'failed', completed_at = now()
      WHERE run_id = ${runId}
        AND status = 'processing'
    `;
    await transaction`
      UPDATE consolidation_runs
      SET status = 'failed', error_code = ${errorCode}, completed_at = now()
      WHERE id = ${runId}
        AND status = 'processing'
    `;
  });
}

async function failRun(
  database: Database,
  runId: string,
  errorCode: string
): Promise<never> {
  await markRunFailed(database, runId, errorCode);
  throw new ConsolidationExecutionError(errorCode, runId);
}

async function persistMemories(
  dependencies: ConsolidationDependencies,
  batch: ClaimedBatch,
  candidates: readonly CandidateMemory[],
  embeddingModel: string,
  embeddings: readonly (readonly number[])[],
  dimensions: number
): Promise<void> {
  await dependencies.database.begin(async (transaction) => {
    await transaction`
      INSERT INTO embedding_models (model_id, provider, dimensions)
      VALUES (
        ${embeddingModel},
        ${dependencies.embeddingProvider.name},
        ${dimensions}
      )
      ON CONFLICT (model_id) DO NOTHING
    `;
    const registeredModels = await transaction<
      Array<{ dimensions: number; provider: string }>
    >`
      SELECT provider, dimensions
      FROM embedding_models
      WHERE model_id = ${embeddingModel}
      LIMIT 1
    `;
    const registeredModel = registeredModels[0];

    if (
      registeredModel === undefined ||
      registeredModel.provider !== dependencies.embeddingProvider.name ||
      registeredModel.dimensions !== dimensions
    ) {
      throw new Error("Embedding model registration does not match provider output");
    }

    for (const [index, candidate] of candidates.entries()) {
      const embedding = embeddings[index];

      if (embedding === undefined) {
        throw new Error("Missing validated embedding");
      }

      const memoryRows = await transaction<RunRow[]>`
        INSERT INTO memories (
          namespace,
          content,
          confidence,
          embedding,
          embedding_model_id,
          generated_by,
          consolidation_run_id,
          metadata
        )
        VALUES (
          ${candidate.namespace},
          ${candidate.content},
          ${candidate.confidence},
          ${JSON.stringify(embedding)}::vector,
          ${embeddingModel},
          ${`${consolidatorVersion}:${dependencies.provider.name}:${dependencies.provider.model}`},
          ${batch.runId},
          ${transaction.json({})}
        )
        RETURNING id
      `;
      const memory = memoryRows[0];

      if (memory === undefined) {
        throw new Error("Memory insert returned no record");
      }

      for (const interactionId of candidate.evidenceInteractionIds) {
        await transaction`
          INSERT INTO memory_evidence (memory_id, interaction_id)
          VALUES (${memory.id}, ${interactionId})
        `;
      }
    }

    await transaction`
      UPDATE consolidation_run_sources
      SET status = 'succeeded', completed_at = now()
      WHERE run_id = ${batch.runId}
        AND status = 'processing'
    `;
    await transaction`
      UPDATE consolidation_runs
      SET
        status = 'succeeded',
        memory_count = ${candidates.length},
        completed_at = now()
      WHERE id = ${batch.runId}
        AND status = 'processing'
    `;
  });
}

async function completeWithoutMemories(
  database: Database,
  batch: ClaimedBatch
): Promise<void> {
  await database.begin(async (transaction) => {
    await transaction`
      UPDATE consolidation_run_sources
      SET status = 'succeeded', completed_at = now()
      WHERE run_id = ${batch.runId}
        AND status = 'processing'
    `;
    await transaction`
      UPDATE consolidation_runs
      SET status = 'succeeded', completed_at = now()
      WHERE id = ${batch.runId}
        AND status = 'processing'
    `;
  });
}

export async function consolidateInteractions(
  dependencies: ConsolidationDependencies,
  requestedBy: string
): Promise<ConsolidationResult> {
  const batch = await claimBatch(dependencies, requestedBy);

  if (batch.interactions.length === 0) {
    return {
      memoryCount: 0,
      runId: batch.runId,
      sourceCount: 0,
      status: "succeeded"
    };
  }

  let candidates: readonly CandidateMemory[];

  try {
    candidates = await dependencies.provider.consolidate(batch.interactions);
    validateEvidence(candidates, batch.interactions);
  } catch {
    return failRun(dependencies.database, batch.runId, "provider_failure");
  }

  if (candidates.length === 0) {
    try {
      await completeWithoutMemories(dependencies.database, batch);
    } catch {
      return failRun(dependencies.database, batch.runId, "persistence_failure");
    }

    return {
      memoryCount: 0,
      runId: batch.runId,
      sourceCount: batch.interactions.length,
      status: "succeeded"
    };
  }

  let embeddingModel: string;
  let embeddings: readonly (readonly number[])[];
  let dimensions: number;

  try {
    const embeddingBatch = await dependencies.embeddingProvider.embedMany(
      candidates.map((candidate) => candidate.content)
    );
    embeddingModel = embeddingBatch.model;
    embeddings = embeddingBatch.embeddings;
    dimensions = validateEmbeddings(embeddings, candidates.length);
  } catch {
    return failRun(dependencies.database, batch.runId, "embedding_failure");
  }

  try {
    await persistMemories(
      dependencies,
      batch,
      candidates,
      embeddingModel,
      embeddings,
      dimensions
    );
  } catch {
    return failRun(dependencies.database, batch.runId, "persistence_failure");
  }

  return {
    memoryCount: candidates.length,
    runId: batch.runId,
    sourceCount: batch.interactions.length,
    status: "succeeded"
  };
}

function sendUnauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .header("WWW-Authenticate", "Bearer")
    .code(401)
    .send({ error: "unauthorized" });
}

export function registerConsolidationRoutes(
  server: FastifyInstance,
  dependencies: ConsolidationDependencies
): void {
  server.post(
    "/admin/consolidate",
    {
      config: {
        rateLimit: { max: 5, timeWindow: 60_000 }
      }
    },
    async (request, reply) => {
      const principal = await authenticatePrincipal(request, dependencies.database);

      if (principal === null) {
        return sendUnauthorized(reply);
      }

      if (!principal.canConsolidate) {
        return reply.code(403).send({ error: "forbidden" });
      }

      if (!requestBodySchema.safeParse(request.body).success) {
        return reply.code(400).send({ error: "invalid_request", fields: [] });
      }

      try {
        return await consolidateInteractions(dependencies, principal.id);
      } catch (error: unknown) {
        if (error instanceof ConsolidationExecutionError) {
          request.log.error(
            {
              errorCode: error.code,
              operation: "consolidation.manual",
              runId: error.runId
            },
            "Consolidation failed"
          );

          const statusCode =
            error.code === "persistence_failure" ? 500 : 502;

          return reply.code(statusCode).send({
            error: "consolidation_failed",
            runId: error.runId
          });
        }

        throw error;
      }
    }
  );
}
