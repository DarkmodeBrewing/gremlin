import { z } from "zod";

export const chatRoleSchema = z.enum(["user", "assistant"]);

export const chatMessageSchema = z
  .object({
    content: z.string().min(1).max(100_000),
    role: chatRoleSchema
  })
  .strict();

const maximumConversationCharacters = 1_000_000;

export const chatRequestSchema = z
  .object({
    conversationId: z.string().uuid(),
    messages: z.array(chatMessageSchema).min(1).max(100)
  })
  .strict()
  .superRefine((request, context) => {
    if (request.messages.at(-1)?.role !== "user") {
      context.addIssue({
        code: "custom",
        message: "The final message must have the user role",
        path: ["messages"]
      });
    }

    const characterCount = request.messages.reduce(
      (total, message) => total + message.content.length,
      0
    );

    if (characterCount > maximumConversationCharacters) {
      context.addIssue({
        code: "too_big",
        maximum: maximumConversationCharacters,
        origin: "array",
        message: "Conversation content is too large",
        path: ["messages"]
      });
    }
  });

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
