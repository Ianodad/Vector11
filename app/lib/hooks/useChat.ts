// Custom hook for chat functionality
import { useState } from "react";
import type { ChatMessage, ChatSource } from "../../types/chat";

interface UseChatOptions {
  onDbWaking?: () => void;
}

const DB_WAKING_FALLBACK =
  "The stats database is still waking up. Give it a few seconds and ask again.";
const TIMEOUT_MESSAGE =
  "That took too long — the database may still be waking up. Try again in a moment.";
const GENERIC_ERROR =
  "Something went wrong reaching the RAG service. Try again in a moment.";

const EMPTY_ANSWER = "I couldn't find an answer just yet. Try refining the question.";
const CUT_OFF_NOTE = "\n\n*The answer was cut off — try asking again.*";
const ERROR_NOTE = "\n\n*Something interrupted the answer — try asking again.*";

type StreamEvent =
  | { type: "sources"; sources: ChatSource[] }
  | { type: "delta"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

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
  const [isStreaming, setIsStreaming] = useState(false);

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

    // Turns a successful response into the assistant's answer (NDJSON stream, or legacy JSON).
    const showAnswer = async (response: Response) => {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/x-ndjson")) {
        const data = await readJson<{ message?: string }>(response);
        addAssistantMessage(data?.message?.trim() || EMPTY_ANSWER);
        return;
      }
      if (!response.body) {
        onDbWaking?.();
        addAssistantMessage(TIMEOUT_MESSAGE);
        return;
      }

      const messageId = crypto.randomUUID();
      let sources: ChatSource[] | undefined;
      let text = "";
      let sawDelta = false;
      let sawDone = false;
      let errorNote = "";

      // Idempotent: appends the message if it is not there yet, otherwise updates it by id.
      const render = () => {
        const content = text + errorNote;
        const snapshotSources = sources;
        setMessages((prev) =>
          prev.some((m) => m.id === messageId)
            ? prev.map((m) =>
                m.id === messageId
                  ? { ...m, content, sources: snapshotSources }
                  : m,
              )
            : [
                ...prev,
                { id: messageId, role: "assistant", content, sources: snapshotSources },
              ],
        );
      };

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let event: StreamEvent;
        try {
          event = JSON.parse(line) as StreamEvent;
        } catch {
          return;
        }
        if (event.type === "sources") {
          sources = Array.isArray(event.sources) ? event.sources : [];
        } else if (event.type === "delta") {
          if (!sawDelta) {
            sawDelta = true;
            setIsStreaming(true);
          }
          text += event.text;
        } else if (event.type === "error") {
          errorNote = ERROR_NOTE;
        } else if (event.type === "done") {
          sawDone = true;
        }
      };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let networkDropped = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          const before = text.length + errorNote.length;
          lines.forEach(handleLine);
          // one state update per network chunk, not per token; the bubble appears on the first text
          if (text.length + errorNote.length !== before) render();
        }
        buffer += decoder.decode();
        handleLine(buffer);
      } catch {
        networkDropped = true;
      }

      if (!sawDone || networkDropped) {
        if (!sawDelta) {
          // nothing usable arrived: treat like a timeout
          onDbWaking?.();
          addAssistantMessage(TIMEOUT_MESSAGE);
          return;
        }
        if (!errorNote) errorNote = CUT_OFF_NOTE;
      }

      if (!sawDelta && !errorNote) text = EMPTY_ANSWER;
      render();
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
      setIsStreaming(false);
      setLoadingLabel(null);
    }
  };

  return {
    messages,
    input,
    setInput,
    isLoading,
    isStreaming,
    loadingLabel,
    handleSubmit,
  };
};
