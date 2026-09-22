import { principalIdSchema } from "./auth.js";
import { loadConfiguration } from "./config.js";
import { closeDatabase, createDatabase } from "./database.js";
import {
  PrincipalKeyRotationError,
  rotatePrincipalApiKey
} from "./principal-credentials.js";

const principalIdResult = principalIdSchema.safeParse(process.argv[2]);

if (!principalIdResult.success || process.argv.length !== 3) {
  process.stderr.write(
    "Usage: pnpm principal:rotate-key <client|agent|system>:<lowercase-name>\n"
  );
  process.exitCode = 1;
} else {
  const configuration = loadConfiguration();
  const database = createDatabase(configuration);

  try {
    const apiKey = await rotatePrincipalApiKey(database, principalIdResult.data);

    process.stderr.write(
      `Rotated key for ${principalIdResult.data}. Store the new key securely; it will not be shown again.\n`
    );
    process.stdout.write(`${apiKey}\n`);
  } catch (error: unknown) {
    process.stderr.write(
      error instanceof PrincipalKeyRotationError
        ? `${error.message}.\n`
        : `Could not rotate key for ${principalIdResult.data}.\n`
    );
    process.exitCode = 1;
  } finally {
    await closeDatabase(database);
  }
}
