import type { FastifyInstance } from "fastify";

import {
  registerConsolidationRoutes,
  type ConsolidationDependencies
} from "./consolidation.js";
import { checkDatabase, type Database } from "./database.js";
import { registerInteractionRoutes } from "./interactions.js";
import { registerMemoryRetrievalRoutes } from "./memory-retrieval.js";
import { buildServer } from "./server.js";

export type ApplicationDependencies = Readonly<{
  consolidation: Omit<ConsolidationDependencies, "database">;
  database: Database;
  logLevel: string | false;
}>;

export async function buildApplication(
  dependencies: ApplicationDependencies
): Promise<FastifyInstance> {
  const server = await buildServer({
    checkDatabase: () => checkDatabase(dependencies.database),
    logLevel: dependencies.logLevel
  });

  registerInteractionRoutes(server, dependencies.database);
  registerMemoryRetrievalRoutes(server, {
    database: dependencies.database,
    embeddingProvider: dependencies.consolidation.embeddingProvider
  });
  registerConsolidationRoutes(server, {
    ...dependencies.consolidation,
    database: dependencies.database
  });

  return server;
}
