// Custom hook for chat functionality
import { useState } from "react";
import type { ChatMessage } from "../../types/chat";

interface UseChatOptions {
  onDbWaking?: () => void;
}

const DB_WAKING_FALLBACK =
  "The stats database is still waking up. Give it a few seconds and ask again.";
const TIMEOUT_MESSAGE =
  "That took too long — the database may still be waking up. Try again in a moment.";
const GENERIC_ERROR =
  "Something went wrong reaching the RAG service. Try again in a moment.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns the server's JSON body, or null when the body is not JSON (e.g. a Vercel 504 page).
const readJson = async <T>(response: Response): Promise<T | null> => {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
};

export const useChat = (options?: UseChatOptions) => {
  const onDbWaking = options?.onDbWaking;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
    };

    const outgoingMessages = [...messages, userMessage];
    setMessages(outgoingMessages);
    setInput("");
    setIsLoading(true);

    const addAssistantMessage = (content: string) => {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content },
      ]);
    };

    const send = () =>
      fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: outgoingMessages }),
      });

    // Turns a successful response into the assistant's answer.
    const showAnswer = async (response: Response) => {
      const data = await readJson<{ message?: string }>(response);
      addAssistantMessage(
        data?.message?.trim() ||
          "I couldn't find an answer just yet. Try refining the question.",
      );
    };

    try {
      let response = await send();

      if (response.ok) {
        await showAnswer(response);
        return;
      }

      const body = await readJson<{ error?: string }>(response);
      const serverError =
        typeof body?.error === "string" && body.error ? body.error : null;

      if (response.status === 503) {
        onDbWaking?.();
        setLoadingLabel("Database is waking up — retrying…");
        const retryAfter = Number(response.headers.get("Retry-After")) || 15;
        await sleep(Math.min(retryAfter, 30) * 1000);

        response = await send();
        if (response.ok) {
          await showAnswer(response);
          return;
        }
        const retryBody = await readJson<{ error?: string }>(response);
        addAssistantMessage(
          (typeof retryBody?.error === "string" && retryBody.error) ||
            serverError ||
            DB_WAKING_FALLBACK,
        );
        return;
      }

      if (serverError) {
        addAssistantMessage(serverError);
        return;
      }

      // Non-JSON body (e.g. Vercel 504 timeout)
      onDbWaking?.();
      addAssistantMessage(TIMEOUT_MESSAGE);
    } catch {
      addAssistantMessage(GENERIC_ERROR);
    } finally {
      setIsLoading(false);
      setLoadingLabel(null);
    }
  };

  return {
    messages,
    input,
    setInput,
    isLoading,
    loadingLabel,
    handleSubmit,
  };
};
