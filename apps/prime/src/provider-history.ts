import type { Database } from "./database.js";
import type { Observation, ProviderKind } from "./provider-health.js";

export async function persistProviderObservation(database: Database, kind: ProviderKind, observation: Observation): Promise<void> {
  await database`INSERT INTO provider_observations (kind, status, http_status, observed_at)
    VALUES (${kind}, ${observation.status}, ${observation.httpStatus}, ${observation.observedAt})`;
}

export async function readProviderHistory(database: Database) {
  const latest = await database<Array<{ kind: ProviderKind; status: string; http_status: number | null; observed_at: Date }>>`
    SELECT DISTINCT ON (kind) kind, status, http_status, observed_at
    FROM provider_observations ORDER BY kind, observed_at DESC, id DESC`;
  const times = await database<Array<{ kind: ProviderKind; last_success: Date | null; last_failure: Date | null }>>`
    SELECT kind, max(observed_at) FILTER (WHERE status = 'ok') AS last_success,
      max(observed_at) FILTER (WHERE status <> 'ok') AS last_failure
    FROM provider_observations GROUP BY kind`;
  const recent = await database<Array<{ id: string; kind: ProviderKind; status: string; http_status: number | null; observed_at: Date }>>`
    SELECT id, kind, status, http_status, observed_at FROM provider_observations
    ORDER BY observed_at DESC, id DESC LIMIT 20`;
  return {
    latest: latest.map(row => ({ kind: row.kind, status: row.status, httpStatus: row.http_status,
      observedAt: row.observed_at.toISOString(),
      lastSuccessAt: times.find(t => t.kind === row.kind)?.last_success?.toISOString() ?? null,
      lastFailureAt: times.find(t => t.kind === row.kind)?.last_failure?.toISOString() ?? null })),
    recent: recent.map(row => ({ id: row.id, kind: row.kind, status: row.status,
      httpStatus: row.http_status, observedAt: row.observed_at.toISOString() }))
  };
}
