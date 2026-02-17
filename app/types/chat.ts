// Chat message types

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};
