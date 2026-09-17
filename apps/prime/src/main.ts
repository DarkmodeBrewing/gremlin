import { buildApplication } from "./application.js";
import {
  loadConfiguration,
  loadConsolidationConfiguration
} from "./config.js";
import { createOpenRouterConsolidationProvider } from "./consolidation-provider.js";
import { closeDatabase, createDatabase } from "./database.js";
import { createOpenRouterEmbeddingProvider } from "./embedding-provider.js";

async function start(): Promise<void> {
  const configuration = loadConfiguration();
  const consolidationConfiguration = loadConsolidationConfiguration();
  const database = createDatabase(configuration);
  const server = await buildApplication({
    consolidation: {
      batchSize: consolidationConfiguration.CONSOLIDATION_BATCH_SIZE,
      embeddingProvider: createOpenRouterEmbeddingProvider({
        apiKey: consolidationConfiguration.OPENROUTER_API_KEY,
        model: consolidationConfiguration.EMBEDDING_MODEL,
        timeoutMilliseconds:
          consolidationConfiguration.MODEL_REQUEST_TIMEOUT_MS
      }),
      maxSourceCharacters:
        consolidationConfiguration.CONSOLIDATION_MAX_SOURCE_CHARACTERS,
      provider: createOpenRouterConsolidationProvider({
        apiKey: consolidationConfiguration.OPENROUTER_API_KEY,
        model: consolidationConfiguration.CONSOLIDATION_MODEL,
        timeoutMilliseconds:
          consolidationConfiguration.MODEL_REQUEST_TIMEOUT_MS
      })
    },
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
