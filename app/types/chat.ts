// Chat message types

export type ChatSource = { url: string; source: string; scrapedAt?: string };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
};
