import { describe, expect, it } from "vitest";
import { parseProviderUsage } from "../src/provider-usage.js";

describe("provider usage validation", () => {
  it("preserves reported zero and discards arbitrary response content", () => {
    expect(parseProviderUsage({ usage: { cost: 0, prompt_tokens: 3, total_tokens: 3, secret: 'private' }, content: 'private' }))
      .toEqual({ costCredits: '0', promptTokens: 3, completionTokens: null, totalTokens: 3 });
  });
  it.each([undefined, null, 'bad', [], {usage: {cost: '0.4', prompt_tokens: -1, completion_tokens: 1.5, total_tokens: Infinity}}])
    ("keeps unknown or invalid usage unknown", value => {
      expect(parseProviderUsage(value)).toEqual({costCredits: null, promptTokens: null, completionTokens: null, totalTokens: null});
    });
  it.each([-1, Infinity, NaN, 1_000_000_001])("rejects invalid cost %s", cost => {
    expect(parseProviderUsage({usage:{cost}}).costCredits).toBeNull();
  });
});
