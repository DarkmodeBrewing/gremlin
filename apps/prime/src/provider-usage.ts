import type { Database } from "./database.js";
import type { ProviderKind } from "./provider-health.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function parseProviderUsage(response: unknown) {
  const usage = object(object(response).usage);
  const tokens = (value: unknown): number | null => typeof value === "number"
    && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const cost = usage.cost;
  return {
    costCredits: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost <= 1_000_000_000
      ? String(cost) : null,
    promptTokens: tokens(usage.prompt_tokens),
    completionTokens: tokens(usage.completion_tokens),
    totalTokens: tokens(usage.total_tokens)
  };
}

export function createProviderUsageRecorder(database: Database) {
  let status: "not_observed" | "ok" | "unavailable" = "not_observed";
  let lastFailureAt: string | null = null;
  return {
    async record(kind: ProviderKind, response: unknown): Promise<void> {
      const usage = parseProviderUsage(response);
      try {
        await database`INSERT INTO provider_usage
          (kind, cost_credits, prompt_tokens, completion_tokens, total_tokens)
          VALUES (${kind}, ${usage.costCredits}, ${usage.promptTokens}, ${usage.completionTokens}, ${usage.totalTokens})`;
        status = "ok";
      } catch {
        // Preserve the provider result; a billing/telemetry failure is not a
        // reason to retry a model request that may already have been billed.
        status = "unavailable";
        lastFailureAt = new Date().toISOString();
      }
    },
    snapshot() { return { status, lastFailureAt }; }
  };
}

export type ProviderUsageRecorder = ReturnType<typeof createProviderUsageRecorder>;

export async function readProviderUsage(database: Database) {
  const summaries = await database<Array<{
    period: string; kind: string; parsed_responses: number; reported_cost_responses: number;
    reported_cost_credits: string | null; prompt_tokens: string | null;
    completion_tokens: string | null; total_tokens: string | null;
  }>>`
    WITH windows AS (
      SELECT 'all_time' AS period, kind, cost_credits, prompt_tokens, completion_tokens, total_tokens FROM provider_usage
      UNION ALL SELECT 'last_24_hours', kind, cost_credits, prompt_tokens, completion_tokens, total_tokens
      FROM provider_usage WHERE recorded_at >= now() - interval '24 hours'
    ) SELECT period, kind, count(*)::int AS parsed_responses,
      count(cost_credits)::int AS reported_cost_responses,
      sum(cost_credits)::text AS reported_cost_credits,
      sum(prompt_tokens)::text AS prompt_tokens,
      sum(completion_tokens)::text AS completion_tokens,
      sum(total_tokens)::text AS total_tokens
    FROM windows GROUP BY period, kind ORDER BY period, kind`;
  return { scope: "prime_parsed_successful_http_responses", unit: "openrouter_credits",
    summaries: summaries.map(row => ({ period: row.period, kind: row.kind,
      parsedResponses: row.parsed_responses, reportedCostResponses: row.reported_cost_responses,
      unknownCostResponses: row.parsed_responses - row.reported_cost_responses,
      reportedCostCredits: row.reported_cost_credits, promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens, totalTokens: row.total_tokens })) };
}
