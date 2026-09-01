import { createHash, randomBytes } from "node:crypto";

import type { FastifyRequest } from "fastify";
import { z } from "zod";

import type { Database } from "./database.js";

const bearerTokenPattern = /^Bearer ([A-Za-z0-9_-]{32,256})$/i;

export const principalIdSchema = z
  .string()
  .regex(/^(client|agent|system):[a-z0-9][a-z0-9-]{0,62}$/);

type PrincipalRow = Readonly<{
  can_ingest_interactions: boolean;
  principal_id: string;
}>;

export type AuthenticatedPrincipal = Readonly<{
  canIngestInteractions: boolean;
  id: string;
}>;

export function createApiKey(): string {
  return `grm_${randomBytes(32).toString("base64url")}`;
}

export function hashApiKey(apiKey: string): string {
  // API keys contain 256 bits from a CSPRNG, unlike human-selected passwords.
  // A fast digest is deliberate: offline guessing is infeasible, while a slow
  // password KDF would make unauthenticated request flooding more expensive.
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export async function authenticatePrincipal(
  request: FastifyRequest,
  database: Database
): Promise<AuthenticatedPrincipal | null> {
  const authorization = request.headers.authorization;

  if (authorization === undefined) {
    return null;
  }

  const apiKey = bearerTokenPattern.exec(authorization)?.[1];

  if (apiKey === undefined) {
    return null;
  }

  const rows = await database<PrincipalRow[]>`
    SELECT principal_id, can_ingest_interactions
    FROM principals
    WHERE api_key_hash = ${hashApiKey(apiKey)}
      AND active = true
    LIMIT 1
  `;
  const principal = rows[0];

  if (principal === undefined) {
    return null;
  }

  return {
    canIngestInteractions: principal.can_ingest_interactions,
    id: principal.principal_id
  };
}
