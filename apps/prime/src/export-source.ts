import { exportCanonicalSources } from "./source-export.js";
import { loadConfiguration } from "./config.js";
import { closeDatabase, createDatabase } from "./database.js";

const outputDirectory = process.argv[2];

if (outputDirectory === undefined || process.argv.length !== 3) {
  process.stderr.write("Usage: pnpm source:export <new-output-directory>\n");
  process.exitCode = 1;
} else {
  const configuration = loadConfiguration();
  const database = createDatabase(configuration);

  try {
    const result = await exportCanonicalSources(database, outputDirectory);
    process.stdout.write(
      `${JSON.stringify({
        level: "info",
        operation: "source-export",
        ...result
      })}\n`
    );
  } catch (error: unknown) {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        operation: "source-export",
        message: error instanceof Error ? error.message : "Unknown export error"
      })}\n`
    );
    process.exitCode = 1;
  } finally {
    await closeDatabase(database);
  }
}
