import type { FastifyInstance, FastifyReply } from "fastify";
import type { TransactionSql } from "postgres";
import { z } from "zod";

import { authenticatePrincipal } from "./auth.js";
import {
  consolidatorVersion,
  selectSources,
  serializeEvent,
  serializeInteraction,
  validateEmbeddings,
  validateEvidence,
  type ConsolidationDependencies
} from "./consolidation.js";
import type { CandidateMemory, ConsolidationSource } from "./consolidation-provider.js";
import type { Database } from "./database.js";

const emptyBody = z.object({}).strict().optional();
const paramsSchema = z.object({ id: z.string().uuid() }).strict();
type IdRow = { id: string };
type SnapshotInteraction = Parameters<typeof serializeInteraction>[0];
type SnapshotEvent = Parameters<typeof serializeEvent>[0];
type Rebuild = { id: string; run_id: string; source_count: number };

class RebuildFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function createSnapshot(database: Database, dependencies: ConsolidationDependencies, requestedBy: string): Promise<Rebuild> {
  return database.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
    const existing = await tx`SELECT id FROM memory_rebuilds WHERE status = 'processing' LIMIT 1`;
    if (existing.length > 0) throw new RebuildFailure("rebuild_in_progress");

    const counts = await tx<Array<{ interactions: number; events: number }>>`
      SELECT (SELECT count(*)::int FROM interactions) AS interactions,
             (SELECT count(*)::int FROM events) AS events`;
    const sourceCount = counts[0]!.interactions + counts[0]!.events;
    const runs = await tx<IdRow[]>`
      INSERT INTO consolidation_runs (requested_by, provider, model, consolidator_version,
        status, trigger_kind, source_count)
      VALUES (${requestedBy}, ${dependencies.provider.name}, ${dependencies.provider.model},
        ${consolidatorVersion}, 'processing', 'full_rebuild', ${sourceCount}) RETURNING id`;
    const rebuilds = await tx<IdRow[]>`
      INSERT INTO memory_rebuilds (consolidation_run_id, requested_by, source_count)
      VALUES (${runs[0]!.id}, ${requestedBy}, ${sourceCount}) RETURNING id`;
    const id = rebuilds[0]!.id;
    await tx`INSERT INTO memory_rebuild_interactions (rebuild_id, interaction_id)
      SELECT ${id}, id FROM interactions`;
    await tx`INSERT INTO memory_rebuild_events (rebuild_id, event_id)
      SELECT ${id}, id FROM events`;
    return { id, run_id: runs[0]!.id, source_count: sourceCount };
  });
}

async function snapshotSources(database: Database, rebuildId: string): Promise<readonly ConsolidationSource[]> {
  const [interactions, events] = await Promise.all([
    database<SnapshotInteraction[]>`
      SELECT i.id, i.conversation_id, i.occurred_at, i.source_principal, i.role, i.content
      FROM memory_rebuild_interactions snapshot
      JOIN interactions i ON i.id = snapshot.interaction_id
      WHERE snapshot.rebuild_id = ${rebuildId}`,
    database<SnapshotEvent[]>`
      SELECT e.id, e.occurred_at, e.source_principal, e.type, e.content
      FROM memory_rebuild_events snapshot
      JOIN events e ON e.id = snapshot.event_id
      WHERE snapshot.rebuild_id = ${rebuildId}`
  ]);
  return [...interactions.map(serializeInteraction), ...events.map(serializeEvent)]
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
}

async function registerEmbeddingModel(
  tx: TransactionSql,
  dependencies: ConsolidationDependencies,
  modelId: string,
  dimensions: number,
  rebuildId: string
): Promise<void> {
  await tx`INSERT INTO embedding_models (model_id, provider, dimensions)
    VALUES (${modelId}, ${dependencies.embeddingProvider.name}, ${dimensions}) ON CONFLICT DO NOTHING`;
  const models = await tx<Array<{ provider: string; dimensions: number }>>`
    SELECT provider, dimensions FROM embedding_models WHERE model_id = ${modelId}`;
  if (models[0]?.provider !== dependencies.embeddingProvider.name || models[0]?.dimensions !== dimensions) {
    throw new RebuildFailure("embedding_model_mismatch");
  }
  const rebuilds = await tx<Array<{ embedding_model_id: string | null }>>`
    SELECT embedding_model_id FROM memory_rebuilds WHERE id = ${rebuildId} FOR UPDATE`;
  if (rebuilds[0]?.embedding_model_id !== null && rebuilds[0]?.embedding_model_id !== modelId) {
    throw new RebuildFailure("embedding_model_changed_during_rebuild");
  }
  await tx`UPDATE memory_rebuilds SET embedding_model_id = ${modelId} WHERE id = ${rebuildId}`;
}

async function stageBatch(
  dependencies: ConsolidationDependencies,
  rebuild: Rebuild,
  candidates: readonly CandidateMemory[],
  modelId: string,
  embeddings: readonly (readonly number[])[],
  dimensions: number
): Promise<void> {
  await dependencies.database.begin(async (tx) => {
    await registerEmbeddingModel(tx, dependencies, modelId, dimensions, rebuild.id);
    const fingerprints = new Set<string>();
    for (const [index, candidate] of candidates.entries()) {
      const interactionIds = candidate.evidence.filter((e) => e.kind === "interaction").map((e) => e.id).sort();
      const eventIds = candidate.evidence.filter((e) => e.kind === "event").map((e) => e.id).sort();
      const fingerprint = JSON.stringify([candidate.namespace, candidate.content, interactionIds, eventIds]);
      if (fingerprints.has(fingerprint)) continue;
      fingerprints.add(fingerprint);
      const rows = await tx<IdRow[]>`
        INSERT INTO memories (namespace, content, confidence, embedding, embedding_model_id,
          generated_by, consolidation_run_id, rebuild_id, metadata)
        VALUES (${candidate.namespace}, ${candidate.content}, ${candidate.confidence},
          ${JSON.stringify(embeddings[index])}::vector, ${modelId},
          ${`${consolidatorVersion}:${dependencies.provider.name}:${dependencies.provider.model}`},
          ${rebuild.run_id}, ${rebuild.id}, ${tx.json({})}) RETURNING id`;
      for (const evidence of candidate.evidence) {
        if (evidence.kind === "interaction") {
          await tx`INSERT INTO memory_evidence (memory_id, interaction_id)
            VALUES (${rows[0]!.id}, ${evidence.id})`;
        } else {
          await tx`INSERT INTO memory_event_evidence (memory_id, event_id)
            VALUES (${rows[0]!.id}, ${evidence.id})`;
        }
      }
    }
  });
}

async function activateRebuild(database: Database, rebuild: Rebuild): Promise<void> {
  await database.begin(async (tx) => {
    // Briefly block memory writers so the cutover has no unsuperseded phantom rows.
    await tx`LOCK TABLE memories IN SHARE ROW EXCLUSIVE MODE`;
    const rows = await tx<Array<{ embedding_model_id: string | null; requested_by: string }>>`
      SELECT embedding_model_id, requested_by FROM memory_rebuilds
      WHERE id = ${rebuild.id} AND status = 'processing' FOR UPDATE`;
    if (rows.length !== 1) throw new RebuildFailure("rebuild_not_processing");
    const staged = await tx<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM memories WHERE rebuild_id = ${rebuild.id}`;
    const previous = await tx<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM memories m
      WHERE m.rebuild_id IS DISTINCT FROM ${rebuild.id}::uuid
        AND NOT EXISTS (SELECT 1 FROM memory_lifecycle_events e WHERE e.memory_id = m.id)
        AND (m.rebuild_id IS NULL OR EXISTS (
          SELECT 1 FROM memory_rebuilds r WHERE r.id = m.rebuild_id AND r.status = 'succeeded'))`;
    if (staged[0]!.count === 0 && previous[0]!.count > 0) {
      throw new RebuildFailure("empty_rebuild");
    }
    await tx`
      INSERT INTO memory_lifecycle_events (memory_id, action, reason, requested_by, superseding_run_id)
      SELECT m.id, 'superseded', 'Full reconstruction', ${rows[0]!.requested_by}, ${rebuild.run_id}
      FROM memories m
      WHERE m.rebuild_id IS DISTINCT FROM ${rebuild.id}::uuid
        AND NOT EXISTS (SELECT 1 FROM memory_lifecycle_events e WHERE e.memory_id = m.id)
        AND (m.rebuild_id IS NULL OR EXISTS (
          SELECT 1 FROM memory_rebuilds r WHERE r.id = m.rebuild_id AND r.status = 'succeeded'))
        AND (EXISTS (SELECT 1 FROM memory_evidence e WHERE e.memory_id = m.id)
          OR EXISTS (SELECT 1 FROM memory_event_evidence e WHERE e.memory_id = m.id))
        AND NOT EXISTS (SELECT 1 FROM memory_evidence e WHERE e.memory_id = m.id
          AND NOT EXISTS (SELECT 1 FROM memory_rebuild_interactions s
            WHERE s.rebuild_id = ${rebuild.id} AND s.interaction_id = e.interaction_id))
        AND NOT EXISTS (SELECT 1 FROM memory_event_evidence e WHERE e.memory_id = m.id
          AND NOT EXISTS (SELECT 1 FROM memory_rebuild_events s
            WHERE s.rebuild_id = ${rebuild.id} AND s.event_id = e.event_id))`;
    await tx`INSERT INTO memory_embedding_state (singleton, active_model_id)
      VALUES (true, ${rows[0]!.embedding_model_id})
      ON CONFLICT (singleton) DO UPDATE SET active_model_id = EXCLUDED.active_model_id`;
    await tx`UPDATE memory_rebuilds SET status = 'succeeded', memory_count = ${staged[0]!.count},
      completed_at = now() WHERE id = ${rebuild.id}`;
    await tx`UPDATE consolidation_runs SET status = 'succeeded', memory_count = ${staged[0]!.count},
      completed_at = now() WHERE id = ${rebuild.run_id}`;
  });
}

async function failRebuild(database: Database, rebuild: Rebuild, code: string): Promise<void> {
  await database.begin(async (tx) => {
    await tx`UPDATE memory_rebuilds SET status = 'failed', error_code = ${code}, completed_at = now()
      WHERE id = ${rebuild.id} AND status = 'processing'`;
    await tx`UPDATE consolidation_runs SET status = 'failed', error_code = ${code}, completed_at = now()
      WHERE id = ${rebuild.run_id} AND status = 'processing'`;
  });
}

export async function executeFullRebuild(dependencies: ConsolidationDependencies, rebuild: Rebuild): Promise<void> {
  try {
    const sources = await snapshotSources(dependencies.database, rebuild.id);
    let offset = 0;
    while (offset < sources.length) {
      const batch = selectSources(sources.slice(offset), dependencies.batchSize, dependencies.maxSourceCharacters);
      let candidates: readonly CandidateMemory[];
      try {
        candidates = await dependencies.provider.consolidate(batch);
        validateEvidence(candidates, batch);
      } catch { throw new RebuildFailure("provider_failure"); }
      if (candidates.length > 0) {
        let embedded;
        let dimensions: number;
        try {
          embedded = await dependencies.embeddingProvider.embedMany(candidates.map((c) => c.content));
          dimensions = validateEmbeddings(embedded.embeddings, candidates.length);
        } catch { throw new RebuildFailure("embedding_failure"); }
        try {
          await stageBatch(dependencies, rebuild, candidates, embedded.model, embedded.embeddings, dimensions);
        } catch (error: unknown) {
          throw error instanceof RebuildFailure ? error : new RebuildFailure("persistence_failure");
        }
      }
      offset += batch.length;
    }
    await activateRebuild(dependencies.database, rebuild);
  } catch (error: unknown) {
    await failRebuild(dependencies.database, rebuild, error instanceof RebuildFailure ? error.code : "rebuild_failure");
    throw error;
  }
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply.header("WWW-Authenticate", "Bearer").code(401).send({ error: "unauthorized" });
}

export function registerFullRebuildRoutes(server: FastifyInstance, dependencies: ConsolidationDependencies): void {
  server.post("/admin/rebuild", { config: { rateLimit: {
    max: dependencies.rateLimit?.maximum ?? 5,
    timeWindow: dependencies.rateLimit?.windowMilliseconds ?? 60_000
  } } }, async (request, reply) => {
    const principal = await authenticatePrincipal(request, dependencies.database);
    if (principal === null) return unauthorized(reply);
    if (!principal.canConsolidate) return reply.code(403).send({ error: "forbidden" });
    if (!emptyBody.safeParse(request.body).success) return reply.code(400).send({ error: "invalid_request", fields: [] });
    let rebuild: Rebuild;
    try {
      rebuild = await createSnapshot(dependencies.database, dependencies, principal.id);
    } catch (error: unknown) {
      if (error instanceof RebuildFailure && error.code === "rebuild_in_progress") {
        return reply.code(409).send({ error: "rebuild_in_progress" });
      }
      if (error !== null && typeof error === "object" && Reflect.get(error, "code") === "23505") {
        return reply.code(409).send({ error: "rebuild_in_progress" });
      }
      throw error;
    }
    setImmediate(() => {
      void executeFullRebuild(dependencies, rebuild).catch((error: unknown) => {
        request.log.error({ operation: "rebuild.full", rebuildId: rebuild.id,
          errorCode: error instanceof RebuildFailure ? error.code : "rebuild_failure" }, "Full rebuild failed");
      });
    });
    return reply.code(202).send({ rebuildId: rebuild.id, runId: rebuild.run_id, sourceCount: rebuild.source_count, status: "processing" });
  });

  server.get("/admin/rebuilds/:id", async (request, reply) => {
    const principal = await authenticatePrincipal(request, dependencies.database);
    if (principal === null) return unauthorized(reply);
    if (!principal.canConsolidate) return reply.code(403).send({ error: "forbidden" });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", fields: ["id"] });
    const rows = await dependencies.database<Array<{
      id: string; consolidation_run_id: string; status: string; source_count: number;
      memory_count: number; embedding_model_id: string | null; error_code: string | null;
      created_at: Date; completed_at: Date | null;
    }>>`
      SELECT id, consolidation_run_id, status, source_count, memory_count,
        embedding_model_id, error_code, created_at, completed_at
      FROM memory_rebuilds WHERE id = ${params.data.id}`;
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    const row = rows[0]!;
    return { rebuildId: row.id, runId: row.consolidation_run_id, status: row.status,
      sourceCount: row.source_count, memoryCount: row.memory_count,
      embeddingModel: row.embedding_model_id, errorCode: row.error_code,
      createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null };
  });
}
