import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { authenticatePrincipal } from "./auth.js";
import type { Database } from "./database.js";
import { memoryParamsSchema } from "./memory-retrieval.js";

const invalidateMemorySchema = z
  .object({
    reason: z.string().trim().min(1).max(2_000)
  })
  .strict();

type LifecycleEventRow = Readonly<{
  action: "invalidated" | "superseded";
  created_at: Date;
  id: string;
  memory_id: string;
  reason: string;
  requested_by: string;
  superseding_memory_id: string | null;
  superseding_run_id: string | null;
}>;

export type SerializedLifecycleEvent = Readonly<{
  action: "invalidated" | "superseded";
  createdAt: string;
  id: string;
  memoryId: string;
  reason: string;
  requestedBy: string;
  supersedingMemoryId: string | null;
  supersedingRunId: string | null;
}>;

export class MemoryLifecycleConflictError extends Error {
  constructor() {
    super("Memory already has a terminal lifecycle event");
    this.name = "MemoryLifecycleConflictError";
  }
}

function serializeLifecycleEvent(
  event: LifecycleEventRow
): SerializedLifecycleEvent {
  return {
    id: event.id,
    memoryId: event.memory_id,
    action: event.action,
    reason: event.reason,
    requestedBy: event.requested_by,
    supersedingMemoryId: event.superseding_memory_id,
    supersedingRunId: event.superseding_run_id,
    createdAt: event.created_at.toISOString()
  };
}

export async function invalidateMemory(
  database: Database,
  memoryId: string,
  requestedBy: string,
  reason: string
): Promise<SerializedLifecycleEvent | null> {
  return database.begin(async (transaction) => {
    const memories = await transaction<Array<{ id: string }>>`
      SELECT id
      FROM memories
      WHERE id = ${memoryId}
      FOR UPDATE
    `;

    if (memories[0] === undefined) {
      return null;
    }

    const existingEvents = await transaction<Array<{ id: string }>>`
      SELECT id
      FROM memory_lifecycle_events
      WHERE memory_id = ${memoryId}
      LIMIT 1
    `;

    if (existingEvents[0] !== undefined) {
      throw new MemoryLifecycleConflictError();
    }

    const events = await transaction<LifecycleEventRow[]>`
      INSERT INTO memory_lifecycle_events (
        memory_id,
        action,
        reason,
        requested_by
      )
      VALUES (
        ${memoryId},
        'invalidated',
        ${reason},
        ${requestedBy}
      )
      RETURNING
        id,
        memory_id,
        action,
        reason,
        requested_by,
        superseding_memory_id,
        superseding_run_id,
        created_at
    `;
    const event = events[0];

    if (event === undefined) {
      throw new Error("Memory lifecycle event insert returned no record");
    }

    return serializeLifecycleEvent(event);
  });
}

function sendUnauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .header("WWW-Authenticate", "Bearer")
    .code(401)
    .send({ error: "unauthorized" });
}

export function registerMemoryLifecycleRoutes(
  server: FastifyInstance,
  database: Database
): void {
  server.post("/admin/memories/:id/invalidate", async (request, reply) => {
    const principal = await authenticatePrincipal(request, database);

    if (principal === null) {
      return sendUnauthorized(reply);
    }

    if (!principal.canConsolidate) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const params = memoryParamsSchema.safeParse(request.params);
    const body = invalidateMemorySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      const fields = [
        ...(params.success
          ? []
          : params.error.issues.map((issue) => issue.path.join("."))),
        ...(body.success
          ? []
          : body.error.issues.map((issue) => issue.path.join(".")))
      ];

      return reply.code(400).send({
        error: "invalid_request",
        fields: [...new Set(fields.filter((field) => field.length > 0))]
      });
    }

    try {
      const lifecycle = await invalidateMemory(
        database,
        params.data.id,
        principal.id,
        body.data.reason
      );

      if (lifecycle === null) {
        return reply.code(404).send({ error: "not_found" });
      }

      return reply.code(201).send({ lifecycle });
    } catch (error: unknown) {
      if (error instanceof MemoryLifecycleConflictError) {
        return reply.code(409).send({ error: "memory_not_active" });
      }

      throw error;
    }
  });
}
