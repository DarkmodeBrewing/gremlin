import type { FastifyInstance } from "fastify";

import {
  registerConsolidationRoutes,
  type ConsolidationDependencies
} from "./consolidation.js";
import { checkDatabase, type Database } from "./database.js";
import { registerEventRoutes } from "./events.js";
import { registerInteractionRoutes } from "./interactions.js";
import { registerMcpRoutes } from "./mcp.js";
import { registerMemoryLifecycleRoutes } from "./memory-lifecycle.js";
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
  registerEventRoutes(server, dependencies.database);
  registerMemoryRetrievalRoutes(server, {
    database: dependencies.database,
    embeddingProvider: dependencies.consolidation.embeddingProvider
  });
  registerMemoryLifecycleRoutes(server, dependencies.database);
  registerMcpRoutes(server, {
    database: dependencies.database,
    embeddingProvider: dependencies.consolidation.embeddingProvider
  });
  registerConsolidationRoutes(server, {
    ...dependencies.consolidation,
    database: dependencies.database
  });

  return server;
}
