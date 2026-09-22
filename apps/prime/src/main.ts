import { buildApplication } from "./application.js";
import {
  loadConfiguration,
  loadConsolidationConfiguration
} from "./config.js";
import { createOpenRouterConsolidationProvider } from "./consolidation-provider.js";
import { recoverInterruptedConsolidationRuns } from "./consolidation.js";
import {
  startConsolidationWorker,
  validateConsolidationWorkerPrincipal
} from "./consolidation-worker.js";
import { closeDatabase, createDatabase } from "./database.js";
import { createOpenRouterEmbeddingProvider } from "./embedding-provider.js";

async function start(): Promise<void> {
  const configuration = loadConfiguration();
  const consolidationConfiguration = loadConsolidationConfiguration();
  const database = createDatabase(configuration);
  const consolidation = {
    batchSize: consolidationConfiguration.CONSOLIDATION_BATCH_SIZE,
    embeddingProvider: createOpenRouterEmbeddingProvider({
      apiKey: consolidationConfiguration.OPENROUTER_API_KEY,
      model: consolidationConfiguration.EMBEDDING_MODEL,
      timeoutMilliseconds: consolidationConfiguration.MODEL_REQUEST_TIMEOUT_MS
    }),
    maxSourceCharacters:
      consolidationConfiguration.CONSOLIDATION_MAX_SOURCE_CHARACTERS,
    provider: createOpenRouterConsolidationProvider({
      apiKey: consolidationConfiguration.OPENROUTER_API_KEY,
      model: consolidationConfiguration.CONSOLIDATION_MODEL,
      timeoutMilliseconds: consolidationConfiguration.MODEL_REQUEST_TIMEOUT_MS
    })
  };
  const server = await buildApplication({
    consolidation,
    database,
    logLevel: configuration.LOG_LEVEL
  });

  const recoveredRunCount = await recoverInterruptedConsolidationRuns(database);
  if (recoveredRunCount > 0) {
    server.log.info(
      { operation: "consolidation.recovery", recoveredRunCount },
      "Recovered interrupted consolidation runs"
    );
  }

  const workerOptions = {
    maxAttempts: consolidationConfiguration.CONSOLIDATION_MAX_ATTEMPTS,
    pollIntervalMilliseconds:
      consolidationConfiguration.CONSOLIDATION_POLL_INTERVAL_MS,
    principalId: consolidationConfiguration.CONSOLIDATION_PRINCIPAL_ID,
    retryDelayMilliseconds:
      consolidationConfiguration.CONSOLIDATION_RETRY_DELAY_MS
  };
  let worker: Readonly<{ stop: () => void }> | undefined;

  if (consolidationConfiguration.BACKGROUND_CONSOLIDATION_ENABLED) {
    await validateConsolidationWorkerPrincipal(
      { ...consolidation, database },
      workerOptions.principalId
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    server.log.info({ signal, operation: "shutdown" }, "Shutting down");

    worker?.stop();
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
    if (consolidationConfiguration.BACKGROUND_CONSOLIDATION_ENABLED) {
      worker = startConsolidationWorker(
        { ...consolidation, database },
        workerOptions,
        server.log
      );
    }
  } catch (error: unknown) {
    server.log.error({ err: error, operation: "startup" }, "Startup failed");
    await closeDatabase(database);
    process.exitCode = 1;
  }
}

await start();
