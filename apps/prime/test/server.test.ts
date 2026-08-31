import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

const servers: ReturnType<typeof buildServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("GET /health", () => {
  it("returns ok when PostgreSQL is reachable", async () => {
    const server = buildServer({
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
    const server = buildServer({
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
});

describe("unhandled request failures", () => {
  it("returns a generic error without exposing internal data", async () => {
    const server = buildServer({
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
