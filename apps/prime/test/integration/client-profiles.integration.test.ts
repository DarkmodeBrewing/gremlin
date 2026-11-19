import { readFileSync } from "node:fs";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseClientProfiles } from "../../src/client-profiles.js";
import { checkClientProfiles } from "../../src/client-profile-check.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const profiles = parseClientProfiles(["gremlin-chat", "opencode"].map(name =>
  JSON.parse(readFileSync(new URL(`../../../../profiles/${name}.json`, import.meta.url), "utf8")) as unknown));
const destinations = { "client:gremlin-chat": "user", "agent:opencode": { namespace: "project/gremlin-chat", includeDescendants: false } };

describe("read-only client profile drift checks", () => {
  let database: Sql;
  beforeAll(async () => {
    database = postgres(url, { max: 1 });
    await database.unsafe("CREATE ROLE m12_profile_reader NOLOGIN");
    await database.unsafe("GRANT USAGE ON SCHEMA public TO m12_profile_reader");
    await database.unsafe("GRANT SELECT (principal_id,active,can_ingest_interactions,can_ingest_events,can_consolidate) ON principals TO m12_profile_reader");
    await database.unsafe("GRANT SELECT (principal_id,namespace_prefix,include_descendants) ON principal_memory_read_policies TO m12_profile_reader");
  });
  beforeEach(async () => {
    await database`TRUNCATE principals CASCADE`;
    await database`INSERT INTO principals(principal_id,api_key_hash,can_ingest_interactions,can_ingest_events) VALUES
      ('client:gremlin-chat',${'a'.repeat(64)},true,false),('agent:opencode',${'b'.repeat(64)},true,true)`;
    await database`INSERT INTO principal_memory_read_policies(principal_id,namespace_prefix,include_descendants) VALUES
      ('client:gremlin-chat','user',true),('agent:opencode','project/gremlin-chat',false)`;
  });
  afterAll(async () => {
    await database.unsafe("DROP OWNED BY m12_profile_reader");
    await database.unsafe("DROP ROLE m12_profile_reader");
    await database.end();
  });

  it("passes existing clients using only metadata-column SELECT permissions", async () => {
    const before = await database`SELECT * FROM principals ORDER BY principal_id`;
    await database.unsafe("SET ROLE m12_profile_reader");
    try {
      const report = await checkClientProfiles(database, profiles, destinations);
      expect(report.result).toBe("PASS");
      expect(report.profiles.map(profile => profile.issues)).toEqual([[], []]);
      await expect(database`SELECT api_key_hash FROM principals`).rejects.toThrow();
      await expect(database`UPDATE principals SET active=false`).rejects.toThrow();
    } finally { await database.unsafe("RESET ROLE"); }
    expect(await database`SELECT * FROM principals ORDER BY principal_id`).toEqual(before);
  });
  it("reports extra permissions, inactivity and privilege drift without changing them", async () => {
    await database`UPDATE principals SET active=false,can_consolidate=true WHERE principal_id='client:gremlin-chat'`;
    await database`INSERT INTO principal_memory_read_policies(principal_id,namespace_prefix,include_descendants) VALUES('agent:opencode','user',true)`;
    const before = await database`SELECT * FROM principal_memory_read_policies ORDER BY principal_id,namespace_prefix`;
    const report = await checkClientProfiles(database, profiles, destinations);
    expect(report.result).toBe("FAIL");
    expect(report.profiles[0]?.issues).toEqual(["principal_inactive", "capabilities_mismatch"]);
    expect(report.profiles[1]?.issues).toContain("read_grants_mismatch");
    expect(await database`SELECT * FROM principal_memory_read_policies ORDER BY principal_id,namespace_prefix`).toEqual(before);
    expect(JSON.stringify(report)).not.toContain('a'.repeat(64));
  });
  it("detects the old namespace bug and exact-grant versus subtree mismatch", async () => {
    const report = await checkClientProfiles(database, profiles, {"client:gremlin-chat":"pets", "agent:opencode":"project/gremlin-chat"});
    expect(report.profiles[0]?.issues).toEqual(["destination_mismatch", "destination_not_readable"]);
    expect(report.profiles[1]?.issues).toEqual(["destination_mismatch", "destination_not_readable"]);
  });
  it("reports missing principals and destinations instead of provisioning them", async () => {
    await database`DELETE FROM principals WHERE principal_id='agent:opencode'`;
    const report = await checkClientProfiles(database, profiles, {});
    expect(report.profiles[0]?.issues).toContain("destination_missing");
    expect(report.profiles[1]?.issues).toEqual(["principal_missing", "read_grants_mismatch", "destination_missing"]);
    expect((await database`SELECT count(*)::int AS count FROM principals`)[0]?.count).toBe(1);
  });
});
