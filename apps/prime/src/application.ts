import type { FastifyInstance } from "fastify";

import {
  registerConsolidationRoutes,
  type ConsolidationDependencies
} from "./consolidation.js";
import { checkDatabase, type Database } from "./database.js";
import { registerEventRoutes } from "./events.js";
import { registerFullRebuildRoutes } from "./full-rebuild.js";
import { registerInteractionRoutes } from "./interactions.js";
import { registerMcpRoutes } from "./mcp.js";
import { registerMemoryLifecycleRoutes } from "./memory-lifecycle.js";
import { registerMemoryRetrievalRoutes } from "./memory-retrieval.js";
import type { ProviderUsageRecorder } from "./provider-usage.js";
import { registerOperationsRoutes } from "./operations.js";
import { createProviderHealth, type ProviderHealth } from "./provider-health.js";
import { buildServer } from "./server.js";

export type ApplicationDependencies = Readonly<{
  consolidation: Omit<ConsolidationDependencies, "database">;
  database: Database;
  logLevel: string | false;
  providerHealth?: ProviderHealth;
  providerUsage?: ProviderUsageRecorder;
}>;

export async function buildApplication(
  dependencies: ApplicationDependencies
): Promise<FastifyInstance> {
  const server = await buildServer({
    checkDatabase: () => checkDatabase(dependencies.database),
    logLevel: dependencies.logLevel
  });

  registerOperationsRoutes(server, dependencies.database, dependencies.providerHealth ?? createProviderHealth(), dependencies.providerUsage);
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
  registerFullRebuildRoutes(server, {
    ...dependencies.consolidation,
    database: dependencies.database
  });

  return server;
}
