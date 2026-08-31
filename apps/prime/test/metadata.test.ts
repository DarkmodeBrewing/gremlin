import { describe, expect, it } from "vitest";

import { validateMetadata } from "../src/metadata.js";

describe("validateMetadata", () => {
  it("accepts ordinary nested source metadata", () => {
    expect(
      validateMetadata({
        model: "example-model",
        provider: "example-provider",
        usage: { inputTokens: 10, outputTokens: 5 }
      })
    ).toBeNull();
  });

  it.each([
    "authorization",
    "api_key",
    "client-secret",
    "password",
    "x-api-key",
    "openaiApiKey"
  ])(
    "rejects the sensitive key %s",
    (key) => {
      expect(validateMetadata({ nested: { [key]: true } })).toContain(
        "sensitive metadata key"
      );
    }
  );

  it("rejects oversized metadata", () => {
    expect(validateMetadata({ value: "x".repeat(33 * 1024) })).toBe(
      "metadata exceeds 32 KiB"
    );
  });
});
