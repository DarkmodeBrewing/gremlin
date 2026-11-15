import { z } from "zod";

const embeddingResponseSchema = z
  .object({
    data: z.array(
      z.object({
        embedding: z.array(z.number().finite()).min(1).max(16_384),
        index: z.number().int().nonnegative()
      })
    ),
    model: z.string().min(1)
  })
  .passthrough();

export type EmbeddingBatch = Readonly<{
  embeddings: readonly (readonly number[])[];
  model: string;
}>;

export interface EmbeddingProvider {
  readonly configuredModel: string;
  readonly name: string;
  embedMany(input: readonly string[], model?: string): Promise<EmbeddingBatch>;
}

export class EmbeddingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

export function createOpenRouterEmbeddingProvider(options: Readonly<{
  apiKey: string;
  fetchImplementation?: typeof fetch;
  model: string;
  timeoutMilliseconds: number;
}>): EmbeddingProvider {
  const fetchImplementation = options.fetchImplementation ?? fetch;

  return {
    configuredModel: options.model,
    name: "openrouter",
    async embedMany(input, model = options.model) {
      if (input.length === 0) {
        return { embeddings: [], model };
      }

      const response = await fetchImplementation(
        "https://openrouter.ai/api/v1/embeddings",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "Gremlin Prime"
          },
          body: JSON.stringify({ input, model }),
          signal: AbortSignal.timeout(options.timeoutMilliseconds)
        }
      );

      if (!response.ok) {
        throw new EmbeddingProviderError(
          `OpenRouter embedding failed with HTTP ${response.status}`
        );
      }

      let responseBody: unknown;

      try {
        responseBody = await response.json();
      } catch {
        throw new EmbeddingProviderError(
          "OpenRouter embedding returned invalid JSON"
        );
      }

      const parsedResponse = embeddingResponseSchema.safeParse(responseBody);

      if (!parsedResponse.success || parsedResponse.data.data.length !== input.length) {
        throw new EmbeddingProviderError(
          "OpenRouter embedding returned an invalid response"
        );
      }

      const orderedEmbeddings: Array<readonly number[] | undefined> = Array.from({
        length: input.length
      });

      for (const item of parsedResponse.data.data) {
        if (
          item.index >= input.length ||
          orderedEmbeddings[item.index] !== undefined
        ) {
          throw new EmbeddingProviderError(
            "OpenRouter embedding returned invalid indexes"
          );
        }

        orderedEmbeddings[item.index] = item.embedding;
      }

      const embeddings = orderedEmbeddings.filter(
        (embedding): embedding is readonly number[] => embedding !== undefined
      );
      const dimensions = embeddings[0]?.length;

      if (
        embeddings.length !== input.length ||
        dimensions === undefined ||
        embeddings.some((embedding) => embedding.length !== dimensions)
      ) {
        throw new EmbeddingProviderError(
          "OpenRouter embedding returned inconsistent dimensions"
        );
      }

      return { embeddings, model: parsedResponse.data.model };
    }
  };
}
