import { z } from "zod";

const configurationSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),
  HTTP_HOST: z.string().min(1).default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info")
});

export type Configuration = z.infer<typeof configurationSchema>;

const consolidationConfigurationSchema = z.object({
  CONSOLIDATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  CONSOLIDATION_MAX_SOURCE_CHARACTERS: z.coerce
    .number()
    .int()
    .min(100_000)
    .max(2_000_000)
    .default(200_000),
  CONSOLIDATION_MODEL: z.string().min(1).max(200),
  CONSOLIDATION_PROVIDER: z.literal("openrouter").default("openrouter"),
  EMBEDDING_MODEL: z.string().min(1).max(200),
  EMBEDDING_PROVIDER: z.literal("openrouter").default("openrouter"),
  MODEL_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(60_000),
  OPENROUTER_API_KEY: z.string().min(16).max(512)
});

export type ConsolidationConfiguration = z.infer<
  typeof consolidationConfigurationSchema
>;

function invalidConfigurationFields(error: z.ZodError): string {
  return error.issues
    .map((issue) => issue.path.join("."))
    .filter((field) => field.length > 0)
    .join(", ");
}

export function loadConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): Configuration {
  const result = configurationSchema.safeParse(environment);

  if (result.success) {
    return result.data;
  }

  throw new Error(
    `Invalid configuration fields: ${invalidConfigurationFields(result.error)}`
  );
}

export function loadConsolidationConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): ConsolidationConfiguration {
  const result = consolidationConfigurationSchema.safeParse(environment);

  if (result.success) {
    return result.data;
  }

  throw new Error(
    `Invalid consolidation configuration fields: ${invalidConfigurationFields(result.error)}`
  );
}
