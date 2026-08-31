import { describe, expect, it } from "vitest";

import { loadConfiguration } from "../src/config.js";

describe("loadConfiguration", () => {
  it("applies safe defaults", () => {
    const configuration = loadConfiguration({
      DATABASE_URL: "postgres://gremlin:secret@localhost:5432/gremlin"
    });

    expect(configuration).toMatchObject({
      DATABASE_MAX_CONNECTIONS: 10,
      HTTP_HOST: "0.0.0.0",
      HTTP_PORT: 3000,
      LOG_LEVEL: "info"
    });
  });

  it("reports invalid field names without leaking their values", () => {
    const sensitiveValue = "not-a-valid-database-url";

    expect(() => loadConfiguration({ DATABASE_URL: sensitiveValue })).toThrow(
      "Invalid configuration fields: DATABASE_URL"
    );

    try {
      loadConfiguration({ DATABASE_URL: sensitiveValue });
    } catch (error: unknown) {
      expect(String(error)).not.toContain(sensitiveValue);
    }
  });
});
