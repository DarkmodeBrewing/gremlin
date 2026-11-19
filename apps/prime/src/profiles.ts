import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkClientProfiles } from "./client-profile-check.js";
import { parseClientProfiles, validateOpenCodeBinding, type ClientProfile } from "./client-profiles.js";
import { consolidationNamespaceRootsSchema, loadConfiguration } from "./config.js";
import { closeDatabase, createDatabase } from "./database.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const mode = process.argv[2];
const suppliedPaths = process.argv.slice(3);
const paths = suppliedPaths.length === 0 ? ["profiles/gremlin-chat.json", "profiles/opencode.json"] : suppliedPaths;
const reportError = (code: string) => {
  process.stdout.write(`${JSON.stringify({ result: "ERROR", code })}\n`);
  process.exitCode = 2;
};
function readDocument(path: string): unknown {
  const absolute = resolve(root, path);
  if (statSync(absolute).size > 64_000) throw new Error("document_too_large");
  return JSON.parse(readFileSync(absolute, "utf8")) as unknown;
}

if ((mode !== "validate" && mode !== "check") || paths.length > 20) {
  reportError("usage_profiles_validate_or_check");
} else {
  let profiles: readonly ClientProfile[] | undefined;
  try {
    profiles = parseClientProfiles(paths.map(readDocument));
    for (const profile of profiles) {
      if (profile.connection.transport === "mcp-streamable-http") {
        validateOpenCodeBinding(profile, readDocument(profile.connection.configurationFile));
      }
    }
  } catch {
    reportError("invalid_profile_or_client_binding");
  }
  if (profiles !== undefined) {
    if (mode === "validate") {
      process.stdout.write(`${JSON.stringify({ mode: "offline", result: "PASS", profiles: profiles.map(profile => ({ id: profile.id, principalId: profile.principalId })) })}\n`);
    } else {
      let configuration: ReturnType<typeof loadConfiguration> | undefined;
      let destinations: ReturnType<typeof consolidationNamespaceRootsSchema.parse> | undefined;
      try {
        configuration = loadConfiguration();
        if (!process.env.CONSOLIDATION_NAMESPACE_ROOTS) throw new Error("missing_destination_configuration");
        destinations = consolidationNamespaceRootsSchema.parse(JSON.parse(process.env.CONSOLIDATION_NAMESPACE_ROOTS));
      } catch {
        reportError("invalid_check_environment");
      }
      if (configuration !== undefined && destinations !== undefined) {
        const database = createDatabase(configuration);
        try {
          const result = await checkClientProfiles(database, profiles, destinations);
          process.stdout.write(`${JSON.stringify(result)}\n`);
          if (result.result !== "PASS") process.exitCode = 1;
        } catch {
          reportError("profile_check_unavailable");
        } finally {
          try { await closeDatabase(database); } catch { reportError("profile_check_unavailable"); }
        }
      }
    }
  }
}
