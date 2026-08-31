import type { FastifyInstance } from "fastify";

import { checkDatabase, type Database } from "./database.js";
import { registerInteractionRoutes } from "./interactions.js";
import { buildServer } from "./server.js";

export type ApplicationDependencies = Readonly<{
  database: Database;
  logLevel: string | false;
}>;

export function buildApplication(
  dependencies: ApplicationDependencies
): FastifyInstance {
  const server = buildServer({
    checkDatabase: () => checkDatabase(dependencies.database),
    logLevel: dependencies.logLevel
  });

  registerInteractionRoutes(server, dependencies.database);

  return server;
}
