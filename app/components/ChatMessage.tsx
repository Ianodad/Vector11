// Individual chat message component
import type { ChatMessage as ChatMessageType } from "../types/chat";
import { MarkdownTable } from "./MarkdownTable";

interface ChatMessageProps {
  message: ChatMessageType;
}

export const ChatMessage = ({ message }: ChatMessageProps) => {
  return (
    <div
      className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm ${
        message.role === "user"
          ? "ml-auto border border-neutral-900 bg-neutral-900 text-white"
          : "border border-neutral-200 bg-white text-neutral-900"
      }`}
    >
      <p className="text-[10px] font-mono uppercase tracking-[0.16em] opacity-80">
        {message.role === "user" ? "You" : "Vector11"}
      </p>
      {message.role === "assistant" ? (
        <MarkdownTable content={message.content} />
      ) : (
        <p className="mt-2 whitespace-pre-wrap">{message.content}</p>
      )}
    </div>
  );
};
