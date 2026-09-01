import { buildApplication } from "./application.js";
import { loadConfiguration } from "./config.js";
import { closeDatabase, createDatabase } from "./database.js";

async function start(): Promise<void> {
  const configuration = loadConfiguration();
  const database = createDatabase(configuration);
  const server = await buildApplication({
    database,
    logLevel: configuration.LOG_LEVEL
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    server.log.info({ signal, operation: "shutdown" }, "Shutting down");

    await server.close();
    await closeDatabase(database);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await server.listen({
      host: configuration.HTTP_HOST,
      port: configuration.HTTP_PORT
    });
  } catch (error: unknown) {
    server.log.error({ err: error, operation: "startup" }, "Startup failed");
    await closeDatabase(database);
    process.exitCode = 1;
  }
}

await start();
