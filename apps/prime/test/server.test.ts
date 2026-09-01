import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("GET /health", () => {
  it("returns ok when PostgreSQL is reachable", async () => {
    const server = await buildServer({
      checkDatabase: async () => undefined,
      logLevel: false
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      dependencies: { database: "ok" }
    });
  });

  it("distinguishes database failure from an empty successful result", async () => {
    const server = await buildServer({
      checkDatabase: async () => {
        throw new Error("PostgreSQL unavailable");
      },
      logLevel: false
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      dependencies: { database: "unavailable" }
    });
  });

  it("remains available after the API rate limit is exhausted", async () => {
    const server = await buildServer({
      checkDatabase: async () => undefined,
      logLevel: false,
      rateLimit: { maximum: 1, windowMilliseconds: 60_000 }
    });
    servers.push(server);
    server.get("/limited", async () => ({ status: "ok" }));

    await server.inject({ method: "GET", url: "/limited" });
    const limitedResponse = await server.inject({
      method: "GET",
      url: "/limited"
    });
    const healthResponse = await server.inject({ method: "GET", url: "/health" });

    expect(limitedResponse.statusCode).toBe(429);
    expect(limitedResponse.headers["retry-after"]).toBeDefined();
    expect(healthResponse.statusCode).toBe(200);
  });
});

describe("API rate limiting", () => {
  it("rejects excess requests before route work runs", async () => {
    const server = await buildServer({
      checkDatabase: async () => undefined,
      logLevel: false,
      rateLimit: { maximum: 2, windowMilliseconds: 60_000 }
    });
    servers.push(server);
    let handledRequests = 0;
    server.get("/limited", async () => {
      handledRequests += 1;
      return { status: "ok" };
    });

    const firstResponse = await server.inject({ method: "GET", url: "/limited" });
    const secondResponse = await server.inject({ method: "GET", url: "/limited" });
    const limitedResponse = await server.inject({ method: "GET", url: "/limited" });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(limitedResponse.statusCode).toBe(429);
    expect(limitedResponse.json()).toEqual({ error: "rate_limit_exceeded" });
    expect(limitedResponse.headers["retry-after"]).toBeDefined();
    expect(handledRequests).toBe(2);
  });
});

describe("unhandled request failures", () => {
  it("returns a generic error without exposing internal data", async () => {
    const server = await buildServer({
      checkDatabase: async () => undefined,
      logLevel: false
    });
    servers.push(server);
    server.get("/failure", async () => {
      throw new Error("interaction-content-must-not-leak");
    });

    const response = await server.inject({ method: "GET", url: "/failure" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_server_error" });
    expect(response.body).not.toContain("interaction-content-must-not-leak");
  });
});
