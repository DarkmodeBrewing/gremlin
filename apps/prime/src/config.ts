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

export function loadConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): Configuration {
  const result = configurationSchema.safeParse(environment);

  if (result.success) {
    return result.data;
  }

  const invalidFields = result.error.issues
    .map((issue) => issue.path.join("."))
    .filter((field) => field.length > 0)
    .join(", ");

  throw new Error(`Invalid configuration fields: ${invalidFields}`);
}
