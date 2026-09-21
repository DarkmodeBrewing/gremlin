import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { authenticatePrincipal } from "./auth.js";
import type { Database } from "./database.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { memoryNamespaceSchema } from "./memory-namespace.js";

export const searchRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(20).default(5),
    query: z.string().min(1).max(20_000)
  })
  .strict();

export const memoryParamsSchema = z.object({ id: z.string().uuid() }).strict();

export const memoryTimelineSchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    includeDescendants: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(20),
    namespace: memoryNamespaceSchema.optional(),
    to: z.string().datetime({ offset: true }).optional()
  })
  .strict()
  .refine(
    ({ from, to }) => from === undefined || to === undefined || from <= to,
    { message: "from must not be after to", path: ["from"] }
  );

export type MemoryTimelineInput = z.infer<typeof memoryTimelineSchema>;

type MemoryRow = Readonly<{
  confidence: number;
  content: string;
  embedding_model_id: string;
  generated_at: Date;
  generated_by: string;
  id: string;
  metadata: Record<string, unknown>;
  namespace: string;
}>;

type SearchMemoryRow = MemoryRow & Readonly<{ similarity: number }>;

type MemoryDetailRow = MemoryRow &
  Readonly<{ evidence_interaction_ids: readonly string[] }>;

export type RetrievedMemory = Readonly<{
  confidence: number;
  content: string;
  embeddingModel: string;
  generatedAt: string;
  generatedBy: string;
  id: string;
  metadata: Readonly<Record<string, unknown>>;
  namespace: string;
  similarity: number;
}>;

type SerializedMemory = Omit<RetrievedMemory, "similarity">;

export type MemoryDetail = SerializedMemory &
  Readonly<{ evidenceInteractionIds: readonly string[] }>;

export type MemoryRetrievalDependencies = Readonly<{
  database: Database;
  embeddingProvider: EmbeddingProvider;
}>;

class MemoryEmbeddingError extends Error {
  constructor() {
    super("Memory query embedding failed");
    this.name = "MemoryEmbeddingError";
  }
}

function sendUnauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .header("WWW-Authenticate", "Bearer")
    .code(401)
    .send({ error: "unauthorized" });
}

function sendInvalidRequest(
  reply: FastifyReply,
  fields: readonly string[]
): FastifyReply {
  return reply.code(400).send({
    error: "invalid_request",
    fields: [...new Set(fields.filter((field) => field.length > 0))]
  });
}

function serializeMemory(memory: MemoryRow): SerializedMemory {
  return {
    id: memory.id,
    namespace: memory.namespace,
    content: memory.content,
    confidence: memory.confidence,
    embeddingModel: memory.embedding_model_id,
    generatedBy: memory.generated_by,
    generatedAt: memory.generated_at.toISOString(),
    metadata: memory.metadata
  };
}

function validateQueryEmbedding(
  embeddings: readonly (readonly number[])[]
): readonly number[] {
  const embedding = embeddings[0];

  if (
    embeddings.length !== 1 ||
    embedding === undefined ||
    embedding.length === 0 ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new MemoryEmbeddingError();
  }

  return embedding;
}

export async function searchMemories(
  dependencies: MemoryRetrievalDependencies,
  principalId: string,
  query: string,
  limit: number
): Promise<readonly RetrievedMemory[]> {
  let embeddingModel: string;
  let queryEmbedding: readonly number[];

  try {
    const embeddingBatch = await dependencies.embeddingProvider.embedMany([query]);
    embeddingModel = embeddingBatch.model;
    queryEmbedding = validateQueryEmbedding(embeddingBatch.embeddings);
  } catch {
    throw new MemoryEmbeddingError();
  }

  const vector = JSON.stringify(queryEmbedding);
  const rows = await dependencies.database<SearchMemoryRow[]>`
    SELECT
      m.id,
      m.namespace,
      m.content,
      m.confidence,
      m.embedding_model_id,
      m.generated_by,
      m.generated_at,
      m.metadata,
      1 - (m.embedding <=> ${vector}::vector) AS similarity
    FROM memories m
    WHERE m.embedding_model_id = ${embeddingModel}
      AND EXISTS (
        SELECT 1
        FROM principal_memory_read_policies policy
        WHERE policy.principal_id = ${principalId}
          AND (
            m.namespace = policy.namespace_prefix
            OR (
              policy.include_descendants
              AND m.namespace LIKE policy.namespace_prefix || '/%'
            )
          )
      )
    ORDER BY m.embedding <=> ${vector}::vector, m.generated_at DESC, m.id
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    ...serializeMemory(row),
    similarity: row.similarity
  }));
}

export async function getMemory(
  database: Database,
  principalId: string,
  memoryId: string
): Promise<MemoryDetail | null> {
  const rows = await database<MemoryDetailRow[]>`
    SELECT
      m.id,
      m.namespace,
      m.content,
      m.confidence,
      m.embedding_model_id,
      m.generated_by,
      m.generated_at,
      m.metadata,
      ARRAY(
        SELECT evidence.interaction_id::text
        FROM memory_evidence evidence
        WHERE evidence.memory_id = m.id
        ORDER BY evidence.interaction_id
      ) AS evidence_interaction_ids
    FROM memories m
    WHERE m.id = ${memoryId}
      AND EXISTS (
        SELECT 1
        FROM principal_memory_read_policies policy
        WHERE policy.principal_id = ${principalId}
          AND (
            m.namespace = policy.namespace_prefix
            OR (
              policy.include_descendants
              AND m.namespace LIKE policy.namespace_prefix || '/%'
            )
          )
      )
    LIMIT 1
  `;
  const memory = rows[0];

  if (memory === undefined) {
    return null;
  }

  return {
    ...serializeMemory(memory),
    evidenceInteractionIds: memory.evidence_interaction_ids
  };
}

export async function getMemoryTimeline(
  database: Database,
  principalId: string,
  input: MemoryTimelineInput
): Promise<readonly SerializedMemory[]> {
  const namespace = input.namespace ?? null;
  const from = input.from === undefined ? null : new Date(input.from);
  const to = input.to === undefined ? null : new Date(input.to);
  const rows = await database<MemoryRow[]>`
    SELECT
      m.id,
      m.namespace,
      m.content,
      m.confidence,
      m.embedding_model_id,
      m.generated_by,
      m.generated_at,
      m.metadata
    FROM memories m
    WHERE EXISTS (
      SELECT 1
      FROM principal_memory_read_policies policy
      WHERE policy.principal_id = ${principalId}
        AND (
          m.namespace = policy.namespace_prefix
          OR (
            policy.include_descendants
            AND m.namespace LIKE policy.namespace_prefix || '/%'
          )
        )
    )
      AND (
        ${namespace}::text IS NULL
        OR m.namespace = ${namespace}
        OR (
          ${input.includeDescendants}
          AND m.namespace LIKE ${namespace} || '/%'
        )
      )
      AND (${from}::timestamptz IS NULL OR m.generated_at >= ${from})
      AND (${to}::timestamptz IS NULL OR m.generated_at <= ${to})
    ORDER BY m.generated_at DESC, m.id DESC
    LIMIT ${input.limit}
  `;

  return rows.map(serializeMemory);
}

export function registerMemoryRetrievalRoutes(
  server: FastifyInstance,
  dependencies: MemoryRetrievalDependencies
): void {
  server.post("/memory/search", async (request, reply) => {
    const principal = await authenticatePrincipal(request, dependencies.database);

    if (principal === null) {
      return sendUnauthorized(reply);
    }

    const result = searchRequestSchema.safeParse(request.body);

    if (!result.success) {
      return sendInvalidRequest(
        reply,
        result.error.issues.map((issue) => issue.path.join("."))
      );
    }

    try {
      const memories = await searchMemories(
        dependencies,
        principal.id,
        result.data.query,
        result.data.limit
      );

      return { memories };
    } catch (error: unknown) {
      if (error instanceof MemoryEmbeddingError) {
        request.log.error(
          { operation: "memory.search.embedding" },
          "Memory query embedding failed"
        );
        return reply.code(502).send({ error: "memory_search_failed" });
      }

      throw error;
    }
  });

  server.get("/memory/:id", async (request, reply) => {
    const principal = await authenticatePrincipal(request, dependencies.database);

    if (principal === null) {
      return sendUnauthorized(reply);
    }

    const result = memoryParamsSchema.safeParse(request.params);

    if (!result.success) {
      return sendInvalidRequest(
        reply,
        result.error.issues.map((issue) => issue.path.join("."))
      );
    }

    const memory = await getMemory(
      dependencies.database,
      principal.id,
      result.data.id
    );

    if (memory === null) {
      return reply.code(404).send({ error: "not_found" });
    }

    return reply.send(memory);
  });
}
