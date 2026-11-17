import { z } from "zod";
import { principalIdSchema } from "./auth.js";
import { memoryDestinationSchema } from "./memory-namespace.js";

const environmentReference = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const toolSchema = z.enum(["memory.search", "memory.get", "memory.timeline", "interaction.append", "event.emit"]);

export type MemoryPolicy = z.infer<typeof memoryDestinationSchema>;

/** A subtree destination must be covered in full, not just its root. */
export function policyCoversDestination(grant: MemoryPolicy, destination: MemoryPolicy): boolean {
  const containsNamespace = grant.namespace === destination.namespace ||
    (grant.includeDescendants && destination.namespace.startsWith(`${grant.namespace}/`));
  return containsNamespace && (!destination.includeDescendants || grant.includeDescendants);
}

export const clientProfileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  principalId: principalIdSchema.refine(id => !id.startsWith("system:")),
  active: z.literal(true),
  capabilities: z.object({
    ingestInteractions: z.boolean(), ingestEvents: z.boolean(), consolidate: z.literal(false)
  }).strict(),
  memory: z.object({
    read: z.array(memoryDestinationSchema).min(1).max(50),
    destination: memoryDestinationSchema
  }).strict(),
  connection: z.discriminatedUnion("transport", [
    z.object({ transport: z.literal("rest"), urlEnv: environmentReference, apiKeyEnv: environmentReference }).strict(),
    z.object({ transport: z.literal("mcp-streamable-http"), urlEnv: environmentReference, apiKeyEnv: environmentReference,
      configurationFile: z.literal("clients/opencode/opencode.json"), tools: z.array(toolSchema).min(1).max(5)
    }).strict()
  ]),
  model: z.discriminatedUnion("selection", [
    z.object({ selection: z.literal("environment"), provider: z.literal("openrouter"),
      modelEnv: environmentReference, apiKeyEnv: environmentReference }).strict(),
    z.object({ selection: z.literal("client-managed") }).strict()
  ]),
  runtime: z.object({ executionOwner: z.literal("external"), kind: z.enum(["service", "external-client"]),
    networkRequirement: z.literal("prime-http-reachable") }).strict(),
  projectContext: z.object({ repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/) }).strict()
}).strict().superRefine((profile, context) => {
  if (!profile.memory.read.some(grant => policyCoversDestination(grant, profile.memory.destination))) {
    context.addIssue({ code: "custom", path: ["memory", "destination"], message: "Destination is not fully readable" });
  }
  const policies = profile.memory.read.map(policy => JSON.stringify(policy));
  if (new Set(policies).size !== policies.length) {
    context.addIssue({ code: "custom", path: ["memory", "read"], message: "Duplicate read policy" });
  }
  if (profile.connection.transport === "mcp-streamable-http") {
    const tools = profile.connection.tools;
    if (new Set(tools).size !== tools.length ||
      (tools.includes("interaction.append") && !profile.capabilities.ingestInteractions) ||
      (tools.includes("event.emit") && !profile.capabilities.ingestEvents)) {
      context.addIssue({ code: "custom", path: ["connection", "tools"], message: "Tools disagree with capabilities" });
    }
  }
});

export type ClientProfile = z.infer<typeof clientProfileSchema>;

/** Return fixed diagnostics; validation errors must never echo credential-like input. */
export function parseClientProfiles(documents: readonly unknown[]): readonly ClientProfile[] {
  if (documents.length === 0 || documents.length > 20) throw new Error("invalid_profile_collection");
  const profiles = documents.map(document => {
    const parsed = clientProfileSchema.safeParse(document);
    if (!parsed.success) throw new Error("invalid_client_profile");
    return parsed.data;
  });
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length ||
    new Set(profiles.map(profile => profile.principalId)).size !== profiles.length) {
    throw new Error("duplicate_profile_identity");
  }
  return profiles;
}

/** Compare with the checked-in adapter file; do not execute or generate client configuration. */
export function validateOpenCodeBinding(profile: ClientProfile, configuration: unknown): void {
  if (profile.connection.transport !== "mcp-streamable-http") return;
  const binding = z.object({
    share: z.literal("disabled"),
    mcp: z.object({ gremlin: z.object({
      type: z.literal("remote"), enabled: z.literal(true), oauth: z.literal(false),
      url: z.literal(`{env:${profile.connection.urlEnv}}`),
      headers: z.object({ Authorization: z.literal(`Bearer {env:${profile.connection.apiKeyEnv}}`) }).strict()
    }).passthrough() }).passthrough(),
    permission: z.object({ "gremlin_*": z.literal("ask") }).passthrough()
  }).passthrough();
  if (!binding.safeParse(configuration).success) throw new Error("opencode_binding_mismatch");
}
