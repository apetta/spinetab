import type { UIMessage } from "ai";

// Shared configuration module, imported type-only by page code.
export type ChatMessage = UIMessage<{ generationId?: string }>;
export const chatApi = "api/chat";
