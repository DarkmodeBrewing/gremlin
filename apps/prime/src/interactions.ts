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

const interactionRoleSchema = z.enum(["user", "assistant", "system", "tool"]);

const appendInteractionSchema = z
  .object({
    content: z.string().min(1).max(100_000),
    conversationId: z.string().uuid(),
    metadata: z.record(z.string(), jsonValueSchema).default({}),
    role: interactionRoleSchema,
    timestamp: z.string().datetime({ offset: true })
  })
  .strict();

const interactionParamsSchema = z
  .object({
    id: z.string().uuid()
  })
  .strict();

type InteractionRole = z.infer<typeof interactionRoleSchema>;

type InteractionRow = Readonly<{
  content: string;
  conversation_id: string;
  created_at: Date;
  id: string;
  metadata: Record<string, JsonValue>;
  occurred_at: Date;
  role: InteractionRole;
  source_principal: string;
}>;

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

function serializeInteraction(interaction: InteractionRow): Record<string, unknown> {
  return {
    id: interaction.id,
    conversationId: interaction.conversation_id,
    timestamp: interaction.occurred_at.toISOString(),
    createdAt: interaction.created_at.toISOString(),
    sourcePrincipal: interaction.source_principal,
    role: interaction.role,
    content: interaction.content,
    metadata: interaction.metadata
  };
}

export function registerInteractionRoutes(
  server: FastifyInstance,
  database: Database
): void {
  server.post("/interactions", async (request, reply) => {
    const principal = await authenticatePrincipal(request, database);

    if (principal === null) {
      return sendUnauthorized(reply);
    }

    if (!principal.canIngestInteractions) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const result = appendInteractionSchema.safeParse(request.body);

    if (!result.success) {
      return sendInvalidRequest(
        reply,
        result.error.issues.map((issue) => issue.path.join("."))
      );
    }

    const metadataIssue = validateMetadata(result.data.metadata);

    if (metadataIssue !== null) {
      return reply.code(400).send({
        error: "invalid_request",
        fields: ["metadata"],
        reason: metadataIssue
      });
    }

    const rows = await database<InteractionRow[]>`
      INSERT INTO interactions (
        conversation_id,
        occurred_at,
        source_principal,
        role,
        content,
        metadata
      )
      VALUES (
        ${result.data.conversationId},
        ${new Date(result.data.timestamp)},
        ${principal.id},
        ${result.data.role},
        ${result.data.content},
        ${database.json(result.data.metadata)}
      )
      RETURNING
        id,
        conversation_id,
        occurred_at,
        created_at,
        source_principal,
        role,
        content,
        metadata
    `;
    const interaction = rows[0];

    if (interaction === undefined) {
      throw new Error("Interaction insert returned no record");
    }

    return reply.code(201).send(serializeInteraction(interaction));
  });

  server.get("/interactions/:id", async (request, reply) => {
    const principal = await authenticatePrincipal(request, database);

    if (principal === null) {
      return sendUnauthorized(reply);
    }

    const result = interactionParamsSchema.safeParse(request.params);

    if (!result.success) {
      return sendInvalidRequest(
        reply,
        result.error.issues.map((issue) => issue.path.join("."))
      );
    }

    const rows = await database<InteractionRow[]>`
      SELECT
        id,
        conversation_id,
        occurred_at,
        created_at,
        source_principal,
        role,
        content,
        metadata
      FROM interactions
      WHERE id = ${result.data.id}
        AND source_principal = ${principal.id}
      LIMIT 1
    `;
    const interaction = rows[0];

    if (interaction === undefined) {
      return reply.code(404).send({ error: "not_found" });
    }

    return reply.send(serializeInteraction(interaction));
  });
}
