import { createParser } from "eventsource-parser";
import { z } from "zod";

import type { ChatMessage } from "./contracts.js";

const streamChunkSchema = z
  .object({
    choices: z
      .array(
        z.object({
          delta: z.object({ content: z.string().optional() }).passthrough(),
          finish_reason: z.string().nullable().optional()
        })
      )
      .optional(),
    error: z
      .object({
        code: z.union([z.string(), z.number()]).optional(),
        message: z.string().optional()
      })
      .optional(),
    id: z.string().optional()
  })
  .passthrough();

export type CompletionResult = Readonly<{
  content: string;
  finishReason: string | null;
  generationId: string | null;
}>;

export interface OpenRouterClient {
  streamCompletion(
    messages: readonly ChatMessage[],
    onDelta: (content: string) => void,
    signal?: AbortSignal
  ): Promise<CompletionResult>;
}

export function createOpenRouterClient(options: Readonly<{
  apiKey: string;
  fetchImplementation?: typeof fetch;
  model: string;
}>): OpenRouterClient {
  const fetchImplementation = options.fetchImplementation ?? fetch;

  return {
    async streamCompletion(messages, onDelta, signal) {
      const response = await fetchImplementation(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "Gremlin Chat"
          },
          body: JSON.stringify({
            messages,
            model: options.model,
            stream: true
          }),
          ...(signal === undefined ? {} : { signal })
        }
      );

      if (!response.ok || response.body === null) {
        throw new Error(`OpenRouter request failed with HTTP ${response.status}`);
      }

      let content = "";
      let finishReason: string | null = null;
      let generationId = response.headers.get("x-generation-id");
      let streamError: Error | null = null;
      let completed = false;

      const parser = createParser({
        onEvent(event) {
          if (event.data === "[DONE]") {
            completed = true;
            return;
          }

          const result = streamChunkSchema.safeParse(JSON.parse(event.data));

          if (!result.success) {
            streamError = new Error("OpenRouter returned an invalid stream event");
            return;
          }

          if (result.data.error !== undefined) {
            streamError = new Error("OpenRouter reported a streaming failure");
            return;
          }

          generationId ??= result.data.id ?? null;
          const choice = result.data.choices?.[0];
          const delta = choice?.delta.content;

          if (delta !== undefined && delta.length > 0) {
            content += delta;
            onDelta(delta);
          }

          if (choice?.finish_reason !== undefined) {
            finishReason = choice.finish_reason;
          }
        }
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          parser.feed(decoder.decode());
          break;
        }

        parser.feed(decoder.decode(value, { stream: true }));

        if (streamError !== null) {
          await reader.cancel();
          throw streamError;
        }
      }

      if (streamError !== null) {
        throw streamError;
      }

      if (!completed) {
        throw new Error("OpenRouter stream ended before completion");
      }

      if (content.length === 0) {
        throw new Error("OpenRouter returned an empty response");
      }

      return { content, finishReason, generationId };
    }
  };
}
