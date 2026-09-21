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

export type RetrievedMemory = Readonly<{
  confidence: number;
  content: string;
  id: string;
  namespace: string;
  similarity: number;
}>;

export interface PrimeClient {
  appendInteraction(interaction: AppendInteraction): Promise<ArchivedInteraction>;
  checkHealth(): Promise<void>;
  searchMemory(query: string, limit: number): Promise<readonly RetrievedMemory[]>;
}

const archivedInteractionSchema = z.object({ id: z.string().uuid() });
const memorySearchResponseSchema = z.object({
  memories: z.array(
    z.object({
      confidence: z.number().min(0).max(1),
      content: z.string().min(1),
      id: z.string().uuid(),
      namespace: z.string().min(1),
      similarity: z.number()
    }).passthrough()
  )
});

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
    },

    async searchMemory(query, limit) {
      const response = await fetchImplementation(`${baseUrl}/memory/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ limit, query }),
        signal: AbortSignal.timeout(10_000)
      });

      if (!response.ok) {
        throw new Error(`Prime memory search failed with HTTP ${response.status}`);
      }

      return memorySearchResponseSchema.parse(await response.json()).memories;
    }
  };
}
