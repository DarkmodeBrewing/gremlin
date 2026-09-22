import { createApiKey, hashApiKey } from "./auth.js";
import type { Database } from "./database.js";

export class PrincipalKeyRotationError extends Error {}

export async function rotatePrincipalApiKey(
  database: Database,
  principalId: string
): Promise<string> {
  const apiKey = createApiKey();
  const rows = await database<Array<{ principal_id: string }>>`
    UPDATE principals
    SET api_key_hash = ${hashApiKey(apiKey)}
    WHERE principal_id = ${principalId}
      AND active = true
    RETURNING principal_id
  `;

  if (rows[0] === undefined) {
    throw new PrincipalKeyRotationError(
      `Principal ${principalId} does not exist or is inactive`
    );
  }

  return apiKey;
}
