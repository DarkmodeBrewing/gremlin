import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseClientProfiles, policyCoversDestination, validateOpenCodeBinding } from "../src/client-profiles.js";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")) as unknown;
const chat = () => parseClientProfiles([read("profiles/gremlin-chat.json")])[0]!;
const opencode = () => parseClientProfiles([read("profiles/opencode.json")])[0]!;

describe("declarative client profiles", () => {
  it("validates both existing client contracts and the checked-in OpenCode binding", () => {
    const profiles = parseClientProfiles([chat(), opencode()]);
    expect(profiles.map(profile => profile.principalId)).toEqual(["client:gremlin-chat", "agent:opencode"]);
    expect(() => validateOpenCodeBinding(profiles[1]!, read("clients/opencode/opencode.json"))).not.toThrow();
  });
  it("distinguishes exact grants, subtree grants and namespace segment boundaries", () => {
    const exact = { namespace: "project/client", includeDescendants: false };
    expect(policyCoversDestination(exact, exact)).toBe(true);
    expect(policyCoversDestination(exact, { ...exact, includeDescendants: true })).toBe(false);
    expect(policyCoversDestination({ namespace: "project", includeDescendants: true }, { ...exact, includeDescendants: true })).toBe(true);
    expect(policyCoversDestination({ namespace: "user", includeDescendants: true }, { namespace: "user-other", includeDescendants: false })).toBe(false);
  });
  it("rejects unversioned, privileged, duplicate and inconsistent declarations", () => {
    const profile = chat();
    const values = [
      {...profile,schemaVersion:2}, {...profile,principalId:"system:consolidator"},
      {...profile,capabilities:{...profile.capabilities,consolidate:true}},
      {...profile,memory:{...profile.memory,destination:{namespace:"pets/cats",includeDescendants:true}}},
      {...profile,memory:{...profile.memory,read:[{namespace:"user",includeDescendants:false}]}},
      {...profile,memory:{...profile.memory,read:[...profile.memory.read,...profile.memory.read]}},
      {...profile,runtime:{...profile.runtime,command:"docker run arbitrary"}}
    ];
    for (const value of values) expect(() => parseClientProfiles([value])).toThrow("invalid_client_profile");
    expect(() => parseClientProfiles([chat(), chat()])).toThrow("duplicate_profile_identity");
    const samePrincipal = chat(); samePrincipal.id = "second";
    expect(() => parseClientProfiles([chat(), samePrincipal])).toThrow("duplicate_profile_identity");
  });
  it("rejects MCP tool/capability mismatch and unsafe credential/client bindings", () => {
    const missing = opencode(); missing.capabilities.ingestEvents = false;
    expect(() => parseClientProfiles([missing])).toThrow();
    const repeated = opencode();
    if (repeated.connection.transport !== "mcp-streamable-http") throw new Error("Unexpected fixture");
    repeated.connection.tools.push("memory.get");
    expect(() => parseClientProfiles([repeated])).toThrow();
    const literal = chat(); literal.connection.apiKeyEnv = "grm_literal-secret-value";
    expect(() => parseClientProfiles([literal])).toThrow();
    const configuration = {share:"disabled",mcp:{gremlin:{type:"remote",enabled:true,oauth:false,
      url:"{env:GREMLIN_MCP_URL}",headers:{Authorization:"Bearer private-sentinel"}}},permission:{"gremlin_*":"ask"}};
    expect(() => validateOpenCodeBinding(opencode(), configuration)).toThrow("opencode_binding_mismatch");
  });
  it("offline CLI needs no database or provider credentials", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/profiles.ts", import.meta.url)), "validate"],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: "invalid-private-sentinel", OPENROUTER_API_KEY: "private-sentinel" } });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "offline", result: "PASS" });
    expect(result.stdout + result.stderr).not.toContain("private-sentinel");
  });
  it("CLI errors do not echo sensitive values or invalid documents", () => {
    const directory = mkdtempSync(join(tmpdir(), "gremlin-profile-test-"));
    try {
      const path = join(directory, "invalid.json"); const value = {...chat(),apiKey:"private-sentinel"};
      writeFileSync(path, JSON.stringify(value));
      const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/profiles.ts", import.meta.url)), "validate", path], { encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual({ result: "ERROR", code: "invalid_profile_or_client_binding" });
      expect(result.stdout + result.stderr).not.toContain("private-sentinel");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
