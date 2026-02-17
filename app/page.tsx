// app/page.tsx
"use client";

import { useRef, useEffect } from "react";
import { Header } from "./components/Header";
import { ChatMessage } from "./components/ChatMessage";
import { LoadingIndicator } from "./components/LoadingIndicator";
import { ChatInput } from "./components/ChatInput";
import { PromptBoard } from "./components/PromptBoard";
import { useChat } from "./lib/hooks/useChat";
import { usePromptRotation } from "./lib/hooks/usePromptRotation";

export default function Home() {
  const { messages, input, setInput, isLoading, handleSubmit } = useChat();
  const { contextPrompts, refreshPrompts } = usePromptRotation();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handlePromptSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    await handleSubmit(event);
    refreshPrompts();
  };

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden bg-gradient-to-b from-stone-100 via-white to-emerald-50/40 text-neutral-900">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_16%_18%,rgba(16,185,129,0.12),transparent_22%),radial-gradient(circle_at_88%_6%,rgba(15,23,42,0.08),transparent_28%)]" />
      <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-8 sm:px-8 lg:px-12 lg:py-10">
        <Header />

        <section className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="overflow-hidden rounded-3xl border border-neutral-900/20 bg-white/90 shadow-[0_20px_50px_-28px_rgba(15,23,42,0.75)] backdrop-blur">
            <div className="flex items-center justify-between border-b border-neutral-900/15 bg-neutral-950 px-5 py-3 text-white">
              <h2 className="text-sm font-mono uppercase tracking-[0.22em]">
                AI Match Desk
              </h2>
              <span className="inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.2em] text-emerald-200">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                v11
              </span>
            </div>
            <div className="flex h-[34rem] flex-col gap-4 overflow-y-auto bg-white p-5 sm:p-6">
              {messages.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 p-5 text-sm text-neutral-700">
                  Ask for fixtures, form trends, or match previews. The assistant
                  stays on the black-and-white brief.
                </div>
              ) : (
                messages.map((message) => (
                  <ChatMessage key={message.id} message={message} />
                ))
              )}
              {isLoading && <LoadingIndicator />}
              <div ref={messagesEndRef} />
            </div>
            <ChatInput
              value={input}
              onChange={setInput}
              onSubmit={handlePromptSubmit}
              isLoading={isLoading}
            />
          </div>

          <PromptBoard
            prompts={contextPrompts}
            onPromptClick={setInput}
            onRefresh={refreshPrompts}
          />
        </section>
      </main>
    </div>
  );
}
