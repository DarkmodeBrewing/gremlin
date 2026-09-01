import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

export type ServerDependencies = Readonly<{
  logLevel: string | false;
  staticRoot: string;
}>;

function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorName: error.name };
  }

  return { errorName: "UnknownError" };
}

export async function buildServer(
  dependencies: ServerDependencies
): Promise<FastifyInstance> {
  const server = Fastify({
    bodyLimit: 1_048_576,
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
    global: false,
    hook: "onRequest"
  });

  await server.register(fastifyStatic, {
    root: dependencies.staticRoot
  });

  server.addHook("onSend", async (_request, reply) => {
    reply
      .header(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      )
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
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

  return server;
}
