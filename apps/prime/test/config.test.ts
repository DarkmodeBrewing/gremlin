import { describe, expect, it } from "vitest";

import {
  loadConfiguration,
  loadConsolidationConfiguration
} from "../src/config.js";

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

describe("loadConsolidationConfiguration", () => {
  it("loads explicit models and applies bounded defaults", () => {
    const configuration = loadConsolidationConfiguration({
      CONSOLIDATION_MODEL: "example/consolidator",
      EMBEDDING_MODEL: "example/embedding",
      OPENROUTER_API_KEY: "openrouter-test-key"
    });

    expect(configuration).toMatchObject({
      CONSOLIDATION_BATCH_SIZE: 20,
      CONSOLIDATION_MAX_SOURCE_CHARACTERS: 200_000,
      CONSOLIDATION_PROVIDER: "openrouter",
      EMBEDDING_PROVIDER: "openrouter",
      MODEL_REQUEST_TIMEOUT_MS: 60_000
    });
  });

  it("reports missing secret fields without printing secret values", () => {
    const sensitiveValue = "short";

    expect(() =>
      loadConsolidationConfiguration({
        CONSOLIDATION_MODEL: "example/consolidator",
        EMBEDDING_MODEL: "example/embedding",
        OPENROUTER_API_KEY: sensitiveValue
      })
    ).toThrow("Invalid consolidation configuration fields: OPENROUTER_API_KEY");

    try {
      loadConsolidationConfiguration({
        CONSOLIDATION_MODEL: "example/consolidator",
        EMBEDDING_MODEL: "example/embedding",
        OPENROUTER_API_KEY: sensitiveValue
      });
    } catch (error: unknown) {
      expect(String(error)).not.toContain(sensitiveValue);
    }
  });
});
