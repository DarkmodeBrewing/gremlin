import { createApiKey, hashApiKey, principalIdSchema } from "./auth.js";
import { loadConfiguration } from "./config.js";
import { closeDatabase, createDatabase } from "./database.js";

const principalIdResult = principalIdSchema.safeParse(process.argv[2]);
const permissionOptions = new Set(process.argv.slice(3));
const validPermissionOptions = [...permissionOptions].every((option) =>
  ["--can-consolidate", "--can-ingest-events"].includes(option)
);
const canConsolidate = permissionOptions.has("--can-consolidate");

if (!principalIdResult.success || !validPermissionOptions) {
  process.stderr.write(
    "Usage: pnpm principal:create <client|agent|system>:<lowercase-name> [--can-consolidate] [--can-ingest-events]\n"
  );
  process.exitCode = 1;
} else {
  const configuration = loadConfiguration();
  const database = createDatabase(configuration);
  const apiKey = createApiKey();

  try {
    await database`
      INSERT INTO principals (
        principal_id,
        api_key_hash,
        can_ingest_interactions,
        can_ingest_events,
        can_consolidate
      )
      VALUES (
        ${principalIdResult.data},
        ${hashApiKey(apiKey)},
        ${!canConsolidate},
        ${permissionOptions.has("--can-ingest-events")},
        ${canConsolidate}
      )
    `;

    process.stderr.write(
      `Created principal ${principalIdResult.data}. Store the API key securely; it will not be shown again.\n`
    );
    process.stdout.write(`${apiKey}\n`);
  } catch {
    process.stderr.write(
      `Could not create principal ${principalIdResult.data}. It may already exist.\n`
    );
    process.exitCode = 1;
  } finally {
    await closeDatabase(database);
  }
}
