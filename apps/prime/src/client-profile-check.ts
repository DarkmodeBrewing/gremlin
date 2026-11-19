import type { z } from "zod";
import type { Database } from "./database.js";
import type { consolidationNamespaceRootsSchema } from "./config.js";
import { policyCoversDestination, type ClientProfile, type MemoryPolicy } from "./client-profiles.js";

type Destinations = z.infer<typeof consolidationNamespaceRootsSchema>;
const policyKey = (policy: MemoryPolicy) => JSON.stringify([policy.namespace, policy.includeDescendants]);
const samePolicies = (a: readonly MemoryPolicy[], b: readonly MemoryPolicy[]) =>
  JSON.stringify(a.map(policyKey).sort()) === JSON.stringify(b.map(policyKey).sort());

/** Snapshot metadata only. Profiles never provision principals or grant permissions. */
export async function checkClientProfiles(database: Database, profiles: readonly ClientProfile[], destinations: Destinations) {
  return database.begin(async transaction => {
    await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    const ids = profiles.map(profile => profile.principalId);
    const principals = await transaction<Array<{
      principal_id: string; active: boolean; can_ingest_interactions: boolean;
      can_ingest_events: boolean; can_consolidate: boolean;
    }>>`SELECT principal_id, active, can_ingest_interactions, can_ingest_events, can_consolidate
      FROM principals WHERE principal_id = ANY(${ids}::text[])`;
    const grants = await transaction<Array<{
      principal_id: string; namespace_prefix: string; include_descendants: boolean;
    }>>`SELECT principal_id, namespace_prefix, include_descendants FROM principal_memory_read_policies
      WHERE principal_id = ANY(${ids}::text[])`;
    const results = profiles.map(profile => {
      const issues: string[] = [];
      const principal = principals.find(row => row.principal_id === profile.principalId);
      const actualRead = grants.filter(row => row.principal_id === profile.principalId)
        .map(row => ({ namespace: row.namespace_prefix, includeDescendants: row.include_descendants }));
      if (!principal) issues.push("principal_missing");
      else {
        if (principal.active !== profile.active) issues.push("principal_inactive");
        if (principal.can_ingest_interactions !== profile.capabilities.ingestInteractions ||
          principal.can_ingest_events !== profile.capabilities.ingestEvents ||
          principal.can_consolidate !== profile.capabilities.consolidate) issues.push("capabilities_mismatch");
      }
      if (!samePolicies(profile.memory.read, actualRead)) issues.push("read_grants_mismatch");
      const configured = destinations[profile.principalId];
      const actualDestination = typeof configured === "string" ? { namespace: configured, includeDescendants: true } : configured;
      if (!actualDestination) issues.push("destination_missing");
      else {
        if (policyKey(actualDestination) !== policyKey(profile.memory.destination)) issues.push("destination_mismatch");
        if (!actualRead.some(grant => policyCoversDestination(grant, actualDestination))) issues.push("destination_not_readable");
      }
      return { id: profile.id, principalId: profile.principalId, status: issues.length === 0 ? "PASS" : "FAIL", issues };
    });
    return { mode: "read_only", result: results.every(result => result.status === "PASS") ? "PASS" : "FAIL", profiles: results };
  });
}
