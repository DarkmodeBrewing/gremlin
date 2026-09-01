import type { FastifyInstance } from "fastify";

import { checkDatabase, type Database } from "./database.js";
import { registerInteractionRoutes } from "./interactions.js";
import { buildServer } from "./server.js";

export type ApplicationDependencies = Readonly<{
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

  return server;
}
