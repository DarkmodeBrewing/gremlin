import type { FastifyInstance, FastifyReply } from "fastify";
import type { TransactionSql } from "postgres";
import { z } from "zod";

import { authenticatePrincipal } from "./auth.js";
import {
  ConsolidationProviderError,
  type CandidateMemory,
  type ConsolidationProvider,
  type ConsolidationSource
} from "./consolidation-provider.js";
import type { Database } from "./database.js";
import {
  EmbeddingProviderError,
  type EmbeddingProvider
} from "./embedding-provider.js";

export const consolidatorVersion = "gremlin-consolidator-v2";
const requestBodySchema = z.object({}).strict().optional();
const runQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20)
});
const sourceReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interaction"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("event"), id: z.string().uuid() }).strict()
]);
const reconstructionSchema = z.object({
  sources: z.array(sourceReferenceSchema).min(1).max(100).refine(
    (sources) => new Set(sources.map((source) => `${source.kind}:${source.id}`)).size === sources.length,
    "Duplicate source reference"
  )
}).strict();
type SourceReference = z.infer<typeof sourceReferenceSchema>;
type Trigger = "manual" | "background" | "reconstruction" | "full_rebuild";
type InteractionRow = Readonly<{
  content: string;
  conversation_id: string;
  id: string;
  occurred_at: Date;
  role: "user" | "assistant" | "system" | "tool";
  source_principal: string;
}>;
type EventRow = Readonly<{
  content: string;
  id: string;
  occurred_at: Date;
  source_principal: string;
  type: string;
}>;
type IdRow = Readonly<{ id: string }>;
type ClaimedBatch = Readonly<{
  requestedBy: string;
  runId: string;
  sources: readonly ConsolidationSource[];
  trigger: Trigger;
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
  rateLimit?: Readonly<{ maximum: number; windowMilliseconds: number }>;
}>;
export type BackgroundConsolidationOptions = Readonly<{
  maxAttempts: number;
  retryDelayMilliseconds: number;
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

export class ReconstructionSourceConflictError extends Error {
  constructor() {
    super("Selected sources are unavailable or exceed the configured batch limits");
    this.name = "ReconstructionSourceConflictError";
  }
}

export function serializeInteraction(row: InteractionRow): ConsolidationSource {
  return {
    content: row.content,
    conversationId: row.conversation_id,
    id: row.id,
    kind: "interaction",
    occurredAt: row.occurred_at,
    role: row.role,
    sourcePrincipal: row.source_principal
  };
}

export function serializeEvent(row: EventRow): ConsolidationSource {
  return {
    content: row.content,
    eventType: row.type,
    id: row.id,
    kind: "event",
    occurredAt: row.occurred_at,
    sourcePrincipal: row.source_principal
  };
}

export function selectSources(
  sources: readonly ConsolidationSource[],
  batchSize: number,
  maximumCharacters: number
): readonly ConsolidationSource[] {
  const ordered = [...sources].sort(
    (left, right) =>
      left.occurredAt.getTime() - right.occurredAt.getTime() ||
      left.id.localeCompare(right.id)
  );
  const selected: ConsolidationSource[] = [];
  let characterCount = 0;
  for (const source of ordered) {
    if (
      selected.length >= batchSize ||
      (selected.length > 0 &&
        characterCount + source.content.length > maximumCharacters)
    ) {
      break;
    }
    selected.push(source);
    characterCount += source.content.length;
  }
  return selected;
}

async function claimBatch(
  dependencies: ConsolidationDependencies,
  requestedBy: string,
  trigger: Trigger,
  background?: BackgroundConsolidationOptions,
  explicitSources?: readonly SourceReference[]
): Promise<ClaimedBatch | null> {
  const manual = trigger === "manual";
  const retryCutoff = new Date(
    Date.now() - (background?.retryDelayMilliseconds ?? 0)
  );
  const maxAttempts = background?.maxAttempts ?? 1;
  return dependencies.database.begin(async (transaction) => {
    const interactions = explicitSources === undefined ? await transaction<InteractionRow[]>`
      SELECT i.id, i.conversation_id, i.occurred_at, i.source_principal, i.role, i.content
      FROM interactions i
      WHERE NOT EXISTS (SELECT 1 FROM consolidation_run_sources source WHERE source.interaction_id = i.id AND source.status IN ('processing', 'succeeded'))
        AND (${manual} OR (
          (SELECT count(*)
           FROM consolidation_run_sources failed
           JOIN consolidation_runs failed_run ON failed_run.id = failed.run_id
           WHERE failed.interaction_id = i.id
             AND failed.status = 'failed'
             AND failed_run.trigger_kind = 'background') < ${maxAttempts}
          AND NOT EXISTS (SELECT 1 FROM consolidation_run_sources recent WHERE recent.interaction_id = i.id AND recent.status = 'failed' AND recent.completed_at > ${retryCutoff})
        ))
      ORDER BY i.occurred_at, i.id LIMIT ${dependencies.batchSize} FOR UPDATE OF i SKIP LOCKED
    ` : await transaction<InteractionRow[]>`
      SELECT i.id, i.conversation_id, i.occurred_at, i.source_principal, i.role, i.content
      FROM interactions i
      WHERE i.id = ANY(${explicitSources.filter((source) => source.kind === "interaction").map((source) => source.id)}::uuid[])
        AND NOT EXISTS (SELECT 1 FROM consolidation_run_sources claimed WHERE claimed.interaction_id = i.id AND claimed.status = 'processing')
      ORDER BY i.id FOR UPDATE OF i SKIP LOCKED
    `;
    const events = explicitSources === undefined ? await transaction<EventRow[]>`
      SELECT e.id, e.occurred_at, e.source_principal, e.type, e.content
      FROM events e
      WHERE NOT EXISTS (SELECT 1 FROM consolidation_run_event_sources source WHERE source.event_id = e.id AND source.status IN ('processing', 'succeeded'))
        AND (${manual} OR (
          (SELECT count(*)
           FROM consolidation_run_event_sources failed
           JOIN consolidation_runs failed_run ON failed_run.id = failed.run_id
           WHERE failed.event_id = e.id
             AND failed.status = 'failed'
             AND failed_run.trigger_kind = 'background') < ${maxAttempts}
          AND NOT EXISTS (SELECT 1 FROM consolidation_run_event_sources recent WHERE recent.event_id = e.id AND recent.status = 'failed' AND recent.completed_at > ${retryCutoff})
        ))
      ORDER BY e.occurred_at, e.id LIMIT ${dependencies.batchSize} FOR UPDATE OF e SKIP LOCKED
    ` : await transaction<EventRow[]>`
      SELECT e.id, e.occurred_at, e.source_principal, e.type, e.content
      FROM events e
      WHERE e.id = ANY(${explicitSources.filter((source) => source.kind === "event").map((source) => source.id)}::uuid[])
        AND NOT EXISTS (SELECT 1 FROM consolidation_run_event_sources claimed WHERE claimed.event_id = e.id AND claimed.status = 'processing')
      ORDER BY e.id FOR UPDATE OF e SKIP LOCKED
    `;
    const selected = selectSources(
      [
        ...interactions.map(serializeInteraction),
        ...events.map(serializeEvent)
      ],
      dependencies.batchSize,
      dependencies.maxSourceCharacters
    );
    if (explicitSources !== undefined && selected.length !== explicitSources.length) {
      throw new ReconstructionSourceConflictError();
    }
    if (selected.length === 0 && !manual) {
      return null;
    }
    const runs = await transaction<IdRow[]>`
      INSERT INTO consolidation_runs (
        requested_by, provider, model, consolidator_version, status,
        trigger_kind, source_count, completed_at
      )
      VALUES (
        ${requestedBy}, ${dependencies.provider.name},
        ${dependencies.provider.model}, ${consolidatorVersion},
        ${selected.length === 0 ? "succeeded" : "processing"}, ${trigger},
        ${selected.length}, ${selected.length === 0 ? new Date() : null}
      )
      RETURNING id
    `;
    const run = runs[0];
    if (run === undefined) {
      throw new Error("Consolidation run insert returned no record");
    }
    for (const source of selected) {
      if (source.kind === "interaction") {
        await transaction`INSERT INTO consolidation_run_sources (run_id, interaction_id, status) VALUES (${run.id}, ${source.id}, 'processing')`;
      } else {
        await transaction`INSERT INTO consolidation_run_event_sources (run_id, event_id, status) VALUES (${run.id}, ${source.id}, 'processing')`;
      }
    }
    return { requestedBy, runId: run.id, sources: selected, trigger };
  });
}

export function validateEvidence(
  candidates: readonly CandidateMemory[],
  sources: readonly ConsolidationSource[]
): void {
  const sourceKeys = new Set(
    sources.map((source) => `${source.kind}:${source.id}`)
  );
  for (const candidate of candidates) {
    if (
      candidate.evidence.some(
        (evidence) => !sourceKeys.has(`${evidence.kind}:${evidence.id}`)
      )
    ) {
      throw new ConsolidationProviderError(
        "Consolidation output referenced evidence outside the source batch"
      );
    }
  }
}

export function validateEmbeddings(
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

async function updateSourceStatuses(
  transaction: TransactionSql,
  runId: string,
  status: "succeeded" | "failed"
): Promise<void> {
  await transaction`UPDATE consolidation_run_sources SET status = ${status}, completed_at = now() WHERE run_id = ${runId} AND status = 'processing'`;
  await transaction`UPDATE consolidation_run_event_sources SET status = ${status}, completed_at = now() WHERE run_id = ${runId} AND status = 'processing'`;
}

async function markRunFailed(
  database: Database,
  runId: string,
  errorCode: string
): Promise<void> {
  await database.begin(async (transaction) => {
    await updateSourceStatuses(transaction, runId, "failed");
    await transaction`UPDATE consolidation_runs SET status = 'failed', error_code = ${errorCode}, completed_at = now() WHERE id = ${runId} AND status = 'processing'`;
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
): Promise<number> {
  return dependencies.database.begin(async (transaction) => {
    const reconstruction = batch.sources.length > 0 && batch.trigger === "reconstruction";
    const selectedInteractions = batch.sources.filter((source) => source.kind === "interaction").map((source) => source.id);
    const selectedEvents = batch.sources.filter((source) => source.kind === "event").map((source) => source.id);
    // Lock eligible memories before comparing fingerprints and changing visibility.
    const eligible = reconstruction ? await transaction<Array<{ id: string }>>`
      SELECT m.id FROM memories m
      WHERE NOT EXISTS (SELECT 1 FROM memory_lifecycle_events lifecycle WHERE lifecycle.memory_id = m.id)
        AND (EXISTS (SELECT 1 FROM memory_evidence me WHERE me.memory_id = m.id AND me.interaction_id = ANY(${selectedInteractions}::uuid[]))
          OR EXISTS (SELECT 1 FROM memory_event_evidence me WHERE me.memory_id = m.id AND me.event_id = ANY(${selectedEvents}::uuid[])))
        AND NOT EXISTS (SELECT 1 FROM memory_evidence me WHERE me.memory_id = m.id AND NOT (me.interaction_id = ANY(${selectedInteractions}::uuid[])))
        AND NOT EXISTS (SELECT 1 FROM memory_event_evidence me WHERE me.memory_id = m.id AND NOT (me.event_id = ANY(${selectedEvents}::uuid[])))
      ORDER BY m.id FOR UPDATE OF m
    ` : [];
    await transaction`INSERT INTO embedding_models (model_id, provider, dimensions) VALUES (${embeddingModel}, ${dependencies.embeddingProvider.name}, ${dimensions}) ON CONFLICT (model_id) DO NOTHING`;
    const models = await transaction<
      Array<{ dimensions: number; provider: string }>
    >`SELECT provider, dimensions FROM embedding_models WHERE model_id = ${embeddingModel} LIMIT 1`;
    const model = models[0];
    if (
      model === undefined ||
      model.provider !== dependencies.embeddingProvider.name ||
      model.dimensions !== dimensions
    ) {
      throw new Error(
        "Embedding model registration does not match provider output"
      );
    }
    await transaction`INSERT INTO memory_embedding_state (singleton, active_model_id)
      VALUES (true, ${embeddingModel}) ON CONFLICT (singleton) DO UPDATE
      SET active_model_id = EXCLUDED.active_model_id
      WHERE memory_embedding_state.active_model_id IS NULL`;
    const retained = new Set<string>();
    const seen = new Set<string>();
    let memoryCount = 0;
    for (const [index, candidate] of candidates.entries()) {
      const embedding = embeddings[index];
      if (embedding === undefined) {
        throw new Error("Missing validated embedding");
      }
      if (reconstruction) {
        const interactionIds = candidate.evidence.filter((evidence) => evidence.kind === "interaction").map((evidence) => evidence.id).sort();
        const eventIds = candidate.evidence.filter((evidence) => evidence.kind === "event").map((evidence) => evidence.id).sort();
        const fingerprint = JSON.stringify([candidate.namespace, candidate.content, interactionIds, eventIds]);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        const existing = await transaction<Array<{ id: string }>>`
          SELECT m.id FROM memories m
          WHERE m.namespace = ${candidate.namespace} AND m.content = ${candidate.content}
            AND NOT EXISTS (SELECT 1 FROM memory_lifecycle_events lifecycle WHERE lifecycle.memory_id = m.id)
            AND ARRAY(SELECT me.interaction_id::text FROM memory_evidence me WHERE me.memory_id = m.id ORDER BY me.interaction_id) = ${interactionIds}::text[]
            AND ARRAY(SELECT me.event_id::text FROM memory_event_evidence me WHERE me.memory_id = m.id ORDER BY me.event_id) = ${eventIds}::text[]
          ORDER BY m.id LIMIT 1 FOR UPDATE OF m
        `;
        if (existing[0] !== undefined) {
          retained.add(existing[0].id);
          continue;
        }
      }
      const memories = await transaction<IdRow[]>`
        INSERT INTO memories (namespace, content, confidence, embedding, embedding_model_id, generated_by, consolidation_run_id, metadata)
        VALUES (${candidate.namespace}, ${candidate.content}, ${candidate.confidence}, ${JSON.stringify(embedding)}::vector, ${embeddingModel}, ${`${consolidatorVersion}:${dependencies.provider.name}:${dependencies.provider.model}`}, ${batch.runId}, ${transaction.json({})}) RETURNING id
      `;
      const memory = memories[0];
      if (memory === undefined) {
        throw new Error("Memory insert returned no record");
      }
      memoryCount++;
      for (const evidence of candidate.evidence) {
        if (evidence.kind === "interaction") {
          await transaction`INSERT INTO memory_evidence (memory_id, interaction_id) VALUES (${memory.id}, ${evidence.id})`;
        } else {
          await transaction`INSERT INTO memory_event_evidence (memory_id, event_id) VALUES (${memory.id}, ${evidence.id})`;
        }
      }
    }
    if (reconstruction && candidates.length > 0) {
      for (const memory of eligible) {
        if (retained.has(memory.id)) continue;
        await transaction`
          INSERT INTO memory_lifecycle_events (memory_id, action, reason, requested_by, superseding_run_id)
          VALUES (${memory.id}, 'superseded', 'Selective reconstruction', ${batch.requestedBy}, ${batch.runId})
        `;
      }
    }
    await updateSourceStatuses(transaction, batch.runId, "succeeded");
    await transaction`UPDATE consolidation_runs SET status = 'succeeded', memory_count = ${memoryCount}, completed_at = now() WHERE id = ${batch.runId} AND status = 'processing'`;
    return memoryCount;
  });
}

async function completeWithoutMemories(
  database: Database,
  batch: ClaimedBatch
): Promise<void> {
  await database.begin(async (transaction) => {
    await updateSourceStatuses(transaction, batch.runId, "succeeded");
    await transaction`UPDATE consolidation_runs SET status = 'succeeded', completed_at = now() WHERE id = ${batch.runId} AND status = 'processing'`;
  });
}

export async function consolidateSources(
  dependencies: ConsolidationDependencies,
  requestedBy: string,
  trigger: Trigger = "manual",
  background?: BackgroundConsolidationOptions,
  explicitSources?: readonly SourceReference[]
): Promise<ConsolidationResult | null> {
  const batch = await claimBatch(dependencies, requestedBy, trigger, background, explicitSources);
  if (batch === null) {
    return null;
  }
  if (batch.sources.length === 0) {
    return {
      memoryCount: 0,
      runId: batch.runId,
      sourceCount: 0,
      status: "succeeded"
    };
  }
  let candidates: readonly CandidateMemory[];
  try {
    candidates = await dependencies.provider.consolidate(batch.sources);
    validateEvidence(candidates, batch.sources);
  } catch {
    return failRun(dependencies.database, batch.runId, "provider_failure");
  }
  if (candidates.length === 0) {
    try {
      await completeWithoutMemories(dependencies.database, batch);
    } catch {
      return failRun(
        dependencies.database,
        batch.runId,
        "persistence_failure"
      );
    }
    return {
      memoryCount: 0,
      runId: batch.runId,
      sourceCount: batch.sources.length,
      status: "succeeded"
    };
  }
  let embeddingModel: string;
  let embeddings: readonly (readonly number[])[];
  let dimensions: number;
  try {
    const embedded = await dependencies.embeddingProvider.embedMany(
      candidates.map((candidate) => candidate.content)
    );
    embeddingModel = embedded.model;
    embeddings = embedded.embeddings;
    dimensions = validateEmbeddings(embeddings, candidates.length);
  } catch {
    return failRun(dependencies.database, batch.runId, "embedding_failure");
  }
  try {
    const memoryCount = await persistMemories(
      dependencies,
      batch,
      candidates,
      embeddingModel,
      embeddings,
      dimensions
    );
    return {
      memoryCount,
      runId: batch.runId,
      sourceCount: batch.sources.length,
      status: "succeeded"
    };
  } catch {
    return failRun(dependencies.database, batch.runId, "persistence_failure");
  }
}

/** Source-compatible alias retained for v0.1 callers. */
export async function consolidateInteractions(
  dependencies: ConsolidationDependencies,
  requestedBy: string
): Promise<ConsolidationResult> {
  const result = await consolidateSources(dependencies, requestedBy);
  if (result === null) {
    throw new Error("Manual consolidation unexpectedly returned no run");
  }
  return result;
}

export async function recoverInterruptedConsolidationRuns(
  database: Database
): Promise<number> {
  return database.begin(async (transaction) => {
    const runs = await transaction<IdRow[]>`SELECT id FROM consolidation_runs WHERE status = 'processing' FOR UPDATE`;
    for (const run of runs) {
      await updateSourceStatuses(transaction, run.id, "failed");
    }
    if (runs.length > 0) {
      await transaction`
        UPDATE memory_rebuilds SET status = 'failed', error_code = 'interrupted', completed_at = now()
        WHERE consolidation_run_id IN ${transaction(runs.map((run) => run.id))} AND status = 'processing'
      `;
      await transaction`
        UPDATE consolidation_runs
        SET status = 'failed', error_code = 'interrupted', completed_at = now()
        WHERE id IN ${transaction(runs.map((run) => run.id))}
      `;
    }
    return runs.length;
  });
}

export async function listConsolidationRuns(
  database: Database,
  limit: number
): Promise<readonly Record<string, unknown>[]> {
  const rows = await database<
    Array<{
      completed_at: Date | null;
      created_at: Date;
      error_code: string | null;
      id: string;
      memory_count: number;
      source_count: number;
      status: string;
      trigger_kind: Trigger;
    }>
  >`
    SELECT id, trigger_kind, status, source_count, memory_count, error_code, created_at, completed_at FROM consolidation_runs ORDER BY created_at DESC, id DESC LIMIT ${limit}
  `;
  return rows.map((run) => ({
    runId: run.id,
    triggerKind: run.trigger_kind,
    status: run.status,
    sourceCount: run.source_count,
    memoryCount: run.memory_count,
    errorCode: run.error_code,
    createdAt: run.created_at.toISOString(),
    completedAt: run.completed_at?.toISOString() ?? null
  }));
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
  server.post("/admin/consolidate", {
    config: {
      rateLimit: {
        max: dependencies.rateLimit?.maximum ?? 5,
        timeWindow: dependencies.rateLimit?.windowMilliseconds ?? 60_000
      }
    }
  }, async (request, reply) => {
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
        return reply
          .code(error.code === "persistence_failure" ? 500 : 502)
          .send({ error: "consolidation_failed", runId: error.runId });
      }
      throw error;
    }
  });
  server.post("/admin/reconstruct", {
    config: {
      rateLimit: {
        max: dependencies.rateLimit?.maximum ?? 5,
        timeWindow: dependencies.rateLimit?.windowMilliseconds ?? 60_000
      }
    }
  }, async (request, reply) => {
    const principal = await authenticatePrincipal(request, dependencies.database);
    if (principal === null) return sendUnauthorized(reply);
    if (!principal.canConsolidate) return reply.code(403).send({ error: "forbidden" });
    const parsed = reconstructionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", fields: ["sources"] });
    try {
      return await consolidateSources(dependencies, principal.id, "reconstruction", undefined, parsed.data.sources);
    } catch (error: unknown) {
      if (error instanceof ReconstructionSourceConflictError) {
        return reply.code(409).send({ error: "sources_unavailable" });
      }
      if (error instanceof ConsolidationExecutionError) {
        request.log.error({ errorCode: error.code, operation: "consolidation.reconstruction", runId: error.runId }, "Reconstruction failed");
        return reply.code(error.code === "persistence_failure" ? 500 : 502)
          .send({ error: "reconstruction_failed", runId: error.runId });
      }
      throw error;
    }
  });
  server.get("/admin/consolidation/runs", async (request, reply) => {
    const principal = await authenticatePrincipal(request, dependencies.database);
    if (principal === null) {
      return sendUnauthorized(reply);
    }
    if (!principal.canConsolidate) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const query = runQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", fields: ["limit"] });
    }
    return {
      runs: await listConsolidationRuns(
        dependencies.database,
        query.data.limit
      )
    };
  });
}
