import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { authenticatePrincipal } from "./auth.js";
import type { Database } from "./database.js";
import { validateMetadata } from "./metadata.js";

type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const emitEventSchema = z
  .object({
    content: z.string().min(1).max(100_000),
    metadata: z.record(z.string(), jsonValueSchema).default({}),
    timestamp: z.string().datetime({ offset: true }),
    type: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9]+([.-][a-z0-9]+)*$/)
  })
  .strict();

const eventParamsSchema = z.object({ id: z.string().uuid() }).strict();

export type EmitEventInput = z.infer<typeof emitEventSchema>;

type EventRow = Readonly<{
  content: string;
  created_at: Date;
  id: string;
  metadata: Record<string, JsonValue>;
  occurred_at: Date;
  source_principal: string;
  type: string;
}>;

export type SerializedEvent = Readonly<{
  content: string;
  createdAt: string;
  id: string;
  metadata: Record<string, JsonValue>;
  sourcePrincipal: string;
  timestamp: string;
  type: string;
}>;

export class InvalidEventMetadataError extends Error {}

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

function serializeEvent(event: EventRow): SerializedEvent {
  return {
    id: event.id,
    timestamp: event.occurred_at.toISOString(),
    createdAt: event.created_at.toISOString(),
    sourcePrincipal: event.source_principal,
    type: event.type,
    content: event.content,
    metadata: event.metadata
  };
}

export async function emitEvent(
  database: Database,
  principalId: string,
  input: EmitEventInput
): Promise<SerializedEvent> {
  const metadataIssue = validateMetadata(input.metadata);

  if (metadataIssue !== null) {
    throw new InvalidEventMetadataError(metadataIssue);
  }

  const rows = await database<EventRow[]>`
    INSERT INTO events (
      occurred_at,
      source_principal,
      type,
      content,
      metadata
    )
    VALUES (
      ${new Date(input.timestamp)},
      ${principalId},
      ${input.type},
      ${input.content},
      ${database.json(input.metadata)}
    )
    RETURNING
      id,
      occurred_at,
      created_at,
      source_principal,
      type,
      content,
      metadata
  `;
  const event = rows[0];

  if (event === undefined) {
    throw new Error("Event insert returned no record");
  }

  return serializeEvent(event);
}

export function registerEventRoutes(
  server: FastifyInstance,
  database: Database
): void {
  server.post("/events", async (request, reply) => {
    const principal = await authenticatePrincipal(request, database);

    if (principal === null) {
      return sendUnauthorized(reply);
    }

    if (!principal.canIngestEvents) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const result = emitEventSchema.safeParse(request.body);

    if (!result.success) {
      return sendInvalidRequest(
        reply,
        result.error.issues.map((issue) => issue.path.join("."))
      );
    }

    try {
      const event = await emitEvent(database, principal.id, result.data);
      return reply.code(201).send(event);
    } catch (error: unknown) {
      if (error instanceof InvalidEventMetadataError) {
        return reply.code(400).send({
          error: "invalid_request",
          fields: ["metadata"],
          reason: error.message
        });
      }

      throw error;
    }
  });

  server.get("/events/:id", async (request, reply) => {
    const principal = await authenticatePrincipal(request, database);

    if (principal === null) {
      return sendUnauthorized(reply);
    }

    const result = eventParamsSchema.safeParse(request.params);

    if (!result.success) {
      return sendInvalidRequest(
        reply,
        result.error.issues.map((issue) => issue.path.join("."))
      );
    }

    const rows = await database<EventRow[]>`
      SELECT
        id,
        occurred_at,
        created_at,
        source_principal,
        type,
        content,
        metadata
      FROM events
      WHERE id = ${result.data.id}
        AND source_principal = ${principal.id}
      LIMIT 1
    `;
    const event = rows[0];

    if (event === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }

    return reply.send(serializeEvent(event));
  });
}
