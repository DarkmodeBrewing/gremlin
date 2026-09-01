import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

const defaultRateLimitMaximum = 300;
const defaultRateLimitWindowMilliseconds = 60_000;

export type ServerDependencies = Readonly<{
  checkDatabase: () => Promise<void>;
  logLevel: string | false;
  rateLimit?: Readonly<{
    maximum: number;
    windowMilliseconds: number;
  }>;
}>;

function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = Reflect.get(error, "code");

    return {
      errorName: error.name,
      ...(typeof code === "string" ? { errorCode: code } : {})
    };
  }

  return { errorName: "UnknownError" };
}

export async function buildServer(
  dependencies: ServerDependencies
): Promise<FastifyInstance> {
  const server = Fastify({
    logger:
      dependencies.logLevel === false
        ? false
        : {
            level: dependencies.logLevel,
            redact: {
              censor: "[REDACTED]",
              paths: ["req.headers.authorization", "req.headers.cookie"]
            }
          }
  });

  await server.register(rateLimit, {
    global: true,
    hook: "onRequest",
    max: dependencies.rateLimit?.maximum ?? defaultRateLimitMaximum,
    timeWindow:
      dependencies.rateLimit?.windowMilliseconds ??
      defaultRateLimitWindowMilliseconds
  });

  server.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error.statusCode;

    if (statusCode === 429) {
      return reply.code(429).send({ error: "rate_limit_exceeded" });
    }

    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: "invalid_request" });
    }

    request.log.error(
      { ...safeErrorDetails(error), operation: "request" },
      "Unhandled request failure"
    );

    return reply.code(500).send({ error: "internal_server_error" });
  });

  server.get(
    "/health",
    {
      config: {
        rateLimit: false
      }
    },
    async (request, reply) => {
      try {
        await dependencies.checkDatabase();

        return {
          status: "ok",
          dependencies: {
            database: "ok"
          }
        };
      } catch (error: unknown) {
        request.log.error(
          { ...safeErrorDetails(error), operation: "health.database" },
          "Database health check failed"
        );

        return reply.code(503).send({
          status: "degraded",
          dependencies: {
            database: "unavailable"
          }
        });
      }
    }
  );

  return server;
}
