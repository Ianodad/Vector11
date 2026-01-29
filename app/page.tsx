"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import Vector11Logo from "./assets/logo.png";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: outgoingMessages }),
      });

      if (!response.ok) {
        throw new Error("Failed to fetch a response.");
      }

      const data = (await response.json()) as { message?: string };
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          data.message?.trim() ||
          "I couldn’t find an answer just yet. Try refining the question.",
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            "Something went wrong reaching the RAG service. Try again in a moment.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-white text-black">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-10 sm:px-10 lg:px-14">
        <header className="flex flex-col gap-6 border-4 border-black p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-5">
            <Image
              src={Vector11Logo}
              alt="Vector11 Logo"
              width={190}
              priority
            />
            <div className="border-l-4 border-black pl-5">
              <p className="text-xs font-mono uppercase tracking-[0.25em]">
                Matchday Intelligence
              </p>
              <h1 className="text-2xl font-semibold sm:text-3xl">
                Vector11 AI Chat
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs font-mono uppercase tracking-[0.18em]">
            <span className="border-2 border-black px-3 py-1">
              Black/White
            </span>
            <span className="border-2 border-black bg-black px-3 py-1 text-white">
              Live
            </span>
          </div>
        </header>

        <section className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="border-4 border-black">
            <div className="flex items-center justify-between border-b-4 border-black bg-black px-5 py-3 text-white">
              <h2 className="text-sm font-mono uppercase tracking-[0.2em]">
                AI Match Desk
              </h2>
              <span className="text-xs font-mono uppercase tracking-[0.2em]">
                v11
              </span>
            </div>
            <div className="flex h-125 flex-col gap-4 overflow-y-auto bg-white p-6">
              {messages.length === 0 ? (
                <div className="border-2 border-dashed border-black p-5 text-sm">
                  Ask for fixtures, form trends, or match previews. The assistant
                  stays on the black-and-white brief.
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`max-w-[85%] px-4 py-3 text-sm ${
                      message.role === "user"
                        ? "ml-auto border-4 border-black bg-black text-white shadow-[6px_6px_0_0_#000]"
                        : "border-2 border-black bg-white text-black shadow-[0_0_0_2px_#000_inset]"
                    }`}
                  >
                    <p className="text-[10px] font-mono uppercase tracking-[0.18em]">
                      {message.role === "user" ? "You" : "Vector11"}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap">{message.content}</p>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
            <form
              onSubmit={handleSubmit}
              className="border-t-4 border-black bg-white p-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Ask about a club, match, or rumor..."
                  className="flex-1 border-2 border-black px-4 py-3 text-sm outline-none"
                />
                <button
                  type="submit"
                  disabled={isLoading}
                  className="border-4 border-black bg-black px-6 py-3 text-sm font-mono uppercase tracking-[0.2em] text-white transition hover:translate-x-1 hover:translate-y-1 disabled:opacity-60"
                >
                  {isLoading ? "Sending" : "Send"}
                </button>
              </div>
            </form>
          </div>

          <aside className="sticky top-6 flex h-fit flex-col gap-6 border-4 border-black p-6">
            <div>
              <h3 className="text-sm font-mono uppercase tracking-[0.2em]">
                Prompt Board
              </h3>
              <p className="mt-2 text-sm">
                Bold, monochrome guidance to keep responses short and tactical.
              </p>
            </div>
            <div className="flex flex-col gap-3">
              {[
                "Scout the weekend fixtures",
                "Summarize injury updates",
                "Compare xG trends for top 4",
                "Who is in form this month?",
              ].map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setInput(prompt)}
                  className="border-2 border-black px-4 py-3 text-left text-sm uppercase tracking-[0.08em] transition hover:bg-black hover:text-white"
                >
                  {prompt}
                </button>
              ))}
            </div>
            <div className="border-2 border-black bg-black p-4 text-white">
              <p className="text-xs font-mono uppercase tracking-[0.2em]">
                Status
              </p>
              <p className="mt-2 text-sm">
                Data sources refreshed from recent feeds and stat tables.
              </p>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
