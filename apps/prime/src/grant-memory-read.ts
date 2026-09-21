import { principalIdSchema } from "./auth.js";
import { loadConfiguration } from "./config.js";
import { closeDatabase, createDatabase } from "./database.js";
import { memoryNamespaceSchema } from "./memory-namespace.js";

type NamespacePolicy = Readonly<{
  includeDescendants: boolean;
  namespacePrefix: string;
}>;

function parsePolicy(value: string): NamespacePolicy | null {
  const includeDescendants = value.endsWith("/*");
  const namespacePrefix = includeDescendants ? value.slice(0, -2) : value;
  const result = memoryNamespaceSchema.safeParse(namespacePrefix);

  if (!result.success) {
    return null;
  }

  return { includeDescendants, namespacePrefix: result.data };
}

const principalIdResult = principalIdSchema.safeParse(process.argv[2]);
const policyResults = process.argv.slice(3).map(parsePolicy);

if (
  !principalIdResult.success ||
  policyResults.length === 0 ||
  policyResults.some((policy) => policy === null)
) {
  process.stderr.write(
    "Usage: pnpm principal:grant-memory-read <principal> <namespace|namespace/*> [...]\n"
  );
  process.exitCode = 1;
} else {
  const configuration = loadConfiguration();
  const database = createDatabase(configuration);

  try {
    await database.begin(async (transaction) => {
      for (const policy of policyResults) {
        if (policy === null) {
          throw new Error("Invalid namespace policy");
        }

        await transaction`
          INSERT INTO principal_memory_read_policies (
            principal_id,
            namespace_prefix,
            include_descendants
          )
          VALUES (
            ${principalIdResult.data},
            ${policy.namespacePrefix},
            ${policy.includeDescendants}
          )
          ON CONFLICT DO NOTHING
        `;
      }
    });

    process.stderr.write(
      `Granted ${policyResults.length} memory read policy entries to ${principalIdResult.data}.\n`
    );
  } catch {
    process.stderr.write(
      `Could not grant memory read policy to ${principalIdResult.data}. Verify that the principal exists.\n`
    );
    process.exitCode = 1;
  } finally {
    await closeDatabase(database);
  }
}
