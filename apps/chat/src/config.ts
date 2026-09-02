import { z } from "zod";

const configurationSchema = z.object({
  DEFAULT_CHAT_MODEL: z.string().min(1).max(200),
  GREMLIN_CHAT_API_KEY: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  GREMLIN_PRIME_URL: z.string().url().default("http://localhost:3000"),
  HTTP_HOST: z.string().min(1).default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  OPENROUTER_API_KEY: z.string().min(16).max(512)
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
