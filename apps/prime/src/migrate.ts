import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { loadConfiguration } from "./config.js";
import { closeDatabase, createDatabase, type Database } from "./database.js";

type AppliedMigration = Readonly<{
  checksum: string;
  name: string;
}>;

const migrationLockName = "gremlin:schema-migrations";
const migrationsDirectory = resolve(import.meta.dirname, "../../../migrations");

async function ensureMigrationTable(database: Database): Promise<void> {
  await database`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

async function loadAppliedMigrations(
  database: Database
): Promise<Map<string, string>> {
  const rows = await database<AppliedMigration[]>`
    SELECT name, checksum
    FROM schema_migrations
  `;

  return new Map(rows.map((row) => [row.name, row.checksum]));
}

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function runMigrations(database: Database): Promise<void> {
  await database`SELECT pg_advisory_lock(hashtext(${migrationLockName}))`;

  try {
    await ensureMigrationTable(database);
    const appliedMigrations = await loadAppliedMigrations(database);
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();

    for (const filename of migrationFiles) {
      const content = await readFile(resolve(migrationsDirectory, filename), "utf8");
      const currentChecksum = checksum(content);
      const appliedChecksum = appliedMigrations.get(filename);

      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== currentChecksum) {
          throw new Error(`Applied migration was modified: ${filename}`);
        }

        continue;
      }

      await database.begin(async (transaction) => {
        await transaction.unsafe(content);
        await transaction`
          INSERT INTO schema_migrations (name, checksum)
          VALUES (${filename}, ${currentChecksum})
        `;
      });

      process.stdout.write(
        `${JSON.stringify({ level: "info", operation: "migrate", migration: filename })}\n`
      );
    }
  } finally {
    await database`SELECT pg_advisory_unlock(hashtext(${migrationLockName}))`;
  }
}

const configuration = loadConfiguration();
const database = createDatabase(configuration);

try {
  await runMigrations(database);
} catch (error: unknown) {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      operation: "migrate",
      message: error instanceof Error ? error.message : "Unknown migration error"
    })}\n`
  );
  process.exitCode = 1;
} finally {
  await closeDatabase(database);
}
