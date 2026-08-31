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
