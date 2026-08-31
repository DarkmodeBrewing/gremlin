import Fastify, { type FastifyInstance } from "fastify";

export type ServerDependencies = Readonly<{
  checkDatabase: () => Promise<void>;
  logLevel: string | false;
}>;

export function buildServer(dependencies: ServerDependencies): FastifyInstance {
  const server = Fastify({
    logger:
      dependencies.logLevel === false
        ? false
        : { level: dependencies.logLevel }
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
        { err: error, operation: "health.database" },
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
