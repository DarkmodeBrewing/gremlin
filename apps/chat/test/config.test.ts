import { describe, expect, it } from "vitest";

import { loadConfiguration } from "../src/config.js";

const requiredEnvironment = {
  DEFAULT_CHAT_MODEL: "example/model",
  GREMLIN_CHAT_API_KEY: "gremlin-test-key-00000000000000000000",
  OPENROUTER_API_KEY: "openrouter-test-key-000000000000000"
};

describe("loadConfiguration", () => {
  it("applies local service defaults", () => {
    const configuration = loadConfiguration(requiredEnvironment);

    expect(configuration).toMatchObject({
      GREMLIN_PRIME_URL: "http://localhost:3000",
      HTTP_HOST: "0.0.0.0",
      HTTP_PORT: 3001,
      LOG_LEVEL: "info"
    });
  });

  it("reports field names without leaking secret values", () => {
    const secretValue = "must-not-leak";

    expect(() =>
      loadConfiguration({
        ...requiredEnvironment,
        GREMLIN_PRIME_URL: secretValue
      })
    ).toThrow("Invalid configuration fields: GREMLIN_PRIME_URL");

    try {
      loadConfiguration({
        ...requiredEnvironment,
        GREMLIN_PRIME_URL: secretValue
      });
    } catch (error: unknown) {
      expect(String(error)).not.toContain(secretValue);
    }
  });
});
