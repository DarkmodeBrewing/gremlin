import { z } from "zod";

export type InteractionRole = "user" | "assistant";

export type AppendInteraction = Readonly<{
  content: string;
  conversationId: string;
  metadata: Readonly<Record<string, string>>;
  role: InteractionRole;
  timestamp: string;
}>;

export type ArchivedInteraction = Readonly<{
  id: string;
}>;

export interface PrimeClient {
  appendInteraction(interaction: AppendInteraction): Promise<ArchivedInteraction>;
  checkHealth(): Promise<void>;
}

const archivedInteractionSchema = z.object({ id: z.string().uuid() });

export function createPrimeClient(options: Readonly<{
  apiKey: string;
  baseUrl: string;
  fetchImplementation?: typeof fetch;
}>): PrimeClient {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return {
    async appendInteraction(interaction) {
      const response = await fetchImplementation(`${baseUrl}/interactions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(interaction),
        signal: AbortSignal.timeout(10_000)
      });

      if (!response.ok) {
        throw new Error(`Prime interaction ingestion failed with HTTP ${response.status}`);
      }

      return archivedInteractionSchema.parse(await response.json());
    },

    async checkHealth() {
      const response = await fetchImplementation(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000)
      });

      if (!response.ok) {
        throw new Error(`Prime health check failed with HTTP ${response.status}`);
      }
    }
  };
}
