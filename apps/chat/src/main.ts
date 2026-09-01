import { buildApplication } from "./application.js";
import { loadConfiguration } from "./config.js";
import { createOpenRouterClient } from "./openrouter-client.js";
import { createPrimeClient } from "./prime-client.js";

async function start(): Promise<void> {
  const configuration = loadConfiguration();
  const primeClient = createPrimeClient({
    apiKey: configuration.GREMLIN_CHAT_API_KEY,
    baseUrl: configuration.GREMLIN_PRIME_URL
  });
  const openRouterClient = createOpenRouterClient({
    apiKey: configuration.OPENROUTER_API_KEY,
    model: configuration.DEFAULT_CHAT_MODEL
  });
  const server = await buildApplication({
    logLevel: configuration.LOG_LEVEL,
    model: configuration.DEFAULT_CHAT_MODEL,
    openRouterClient,
    primeClient
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    server.log.info({ signal, operation: "shutdown" }, "Shutting down");
    await server.close();
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
    process.exitCode = 1;
  }
}

await start();
