import type { FastifyInstance } from "fastify";

import { operationsAlerts } from "./operations-alerts.js";
import { readProviderHistory } from "./provider-history.js";
import { authenticatePrincipal } from "./auth.js";
import { listConsolidationRuns } from "./consolidation.js";
import type { Database } from "./database.js";
import type { ProviderHealth } from "./provider-health.js";

export function registerOperationsRoutes(
  server: FastifyInstance,
  database: Database,
  providerHealth: ProviderHealth
): void {
  server.get("/admin/operations", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const principal = await authenticatePrincipal(request, database);
    if (principal === null) {
      return reply.header("WWW-Authenticate", "Bearer").code(401).send({ error: "unauthorized" });
    }
    if (!principal.canConsolidate) return reply.code(403).send({ error: "forbidden" });

    // Count source IDs, not attempts. Failed sources remain backlog even when
    // retries are delayed or exhausted; this is not a count of runnable work.
    const sources = await database<Array<{ kind: string; status: string; count: number; oldest_at: Date }>>`
      WITH sources AS (
        SELECT 'interaction' AS kind, id, created_at FROM interactions
        UNION ALL SELECT 'event', id, created_at FROM events
      ), claims AS (
        SELECT 'interaction' AS kind, interaction_id AS id, status FROM consolidation_run_sources
        UNION ALL SELECT 'event', event_id, status FROM consolidation_run_event_sources
      ), states AS (
        SELECT s.kind, s.id, s.created_at,
          CASE WHEN bool_or(c.status = 'processing') THEN 'processing'
            WHEN bool_or(c.status = 'succeeded') THEN 'succeeded'
            WHEN bool_or(c.status = 'failed') THEN 'failed'
            ELSE 'pending' END AS status
        FROM sources s LEFT JOIN claims c ON c.kind = s.kind AND c.id = s.id
        GROUP BY s.kind, s.id, s.created_at
      ) SELECT kind, status, count(*)::int AS count, min(created_at) AS oldest_at FROM states GROUP BY kind, status`;
    const [runs] = await database<Array<{ processing: number; failed: number; succeeded: number; last_success_at: Date | null; oldest_processing_at: Date | null }>>`
      SELECT count(*) FILTER (WHERE status = 'processing')::int AS processing,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        max(completed_at) FILTER (WHERE status = 'succeeded') AS last_success_at,
        min(created_at) FILTER (WHERE status = 'processing') AS oldest_processing_at
      FROM consolidation_runs`;
    const counts = { pending: 0, processing: 0, failed: 0, succeeded: 0 };
    for (const row of sources) {
      if (row.status in counts) counts[row.status as keyof typeof counts] += row.count;
    }
    const providerHistory = await readProviderHistory(database);
    const unresolved = sources.filter(row => row.status === "pending" || row.status === "failed");
    const oldestUnresolvedAt = unresolved.length === 0 ? null : new Date(Math.min(...unresolved.map(row => row.oldest_at.getTime())));
    const alerts = operationsAlerts({ providers: providerHistory.latest,
      persistenceStatus: providerHealth.persistence().status,
      backlog: counts.pending + counts.failed, oldestUnresolvedAt,
      lastSuccessAt: runs!.last_success_at, oldestProcessingAt: runs!.oldest_processing_at });
    return {
      alerts,
      providerHistory,
      providerTelemetry: providerHealth.persistence(),
      observedAt: new Date().toISOString(),
      providers: providerHealth.snapshot(),
      consolidation: {
        backlog: counts.pending + counts.failed,
        sources: counts,
        runs: { processing: runs!.processing, failed: runs!.failed, succeeded: runs!.succeeded },
        lastSuccessfulRunAt: runs!.last_success_at?.toISOString() ?? null,
        recentRuns: await listConsolidationRuns(database, 10)
      }
    };
  });
}
