// Individual chat message component
import type { ChatMessage as ChatMessageType } from "../types/chat";
import { MarkdownTable } from "./MarkdownTable";

// "6 Oct" style; empty string when the date is missing or invalid
const formatShortDate = (iso?: string) => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

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
        <>
          <MarkdownTable content={message.content} />
          {message.sources && message.sources.length > 0 && (
            <div className="mt-3 border-t border-neutral-200 pt-2 text-xs text-neutral-600">
              <p className="text-[10px] font-mono uppercase tracking-[0.16em] opacity-80">
                Retrieved from
              </p>
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {message.sources.map((source) => {
                  const date = formatShortDate(source.scrapedAt);
                  return (
                    <li key={source.url}>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        {source.source}
                      </a>
                      {date && <span className="text-neutral-400"> · {date}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className="mt-2 whitespace-pre-wrap">{message.content}</p>
      )}
    </div>
  );
};
