import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

export type ServerDependencies = Readonly<{
  checkDatabase: () => Promise<void>;
  logLevel: string | false;
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

export function buildServer(dependencies: ServerDependencies): FastifyInstance {
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

  server.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error.statusCode;

    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: "invalid_request" });
    }

    request.log.error(
      { ...safeErrorDetails(error), operation: "request" },
      "Unhandled request failure"
    );

    return reply.code(500).send({ error: "internal_server_error" });
  });

  server.get("/health", async (request, reply) => {
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
  });

  return server;
}
