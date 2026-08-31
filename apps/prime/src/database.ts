import postgres, { type Sql } from "postgres";

import type { Configuration } from "./config.js";

export type Database = Sql;

export function createDatabase(configuration: Configuration): Database {
  return postgres(configuration.DATABASE_URL, {
    max: configuration.DATABASE_MAX_CONNECTIONS
  });
}

export async function checkDatabase(database: Database): Promise<void> {
  await database`SELECT 1`;
}

export async function closeDatabase(database: Database): Promise<void> {
  await database.end({ timeout: 5 });
}
