// app/page.tsx
"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Vector11Logo from "./assets/logo.png";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const CONTEXT_PROMPTS = [
  "Who is the top scorer in the EPL right now?",
  "Which players have the most assists in the EPL this season?",
  "Which EPL team has the best defensive record so far?",
  "Which goalkeeper has the most clean sheets this season?",
  "Which club has the highest xG over the last five matches?",
  "Which team has the best recent form in the last five games?",
  "Who has created the most big chances in the EPL?",
  "Which midfielders lead progressive passes this season?",
  "Which strikers are outperforming their xG the most?",
  "Which attackers are underperforming their xG this season?",
  "How does Arsenal's home form compare to away form?",
  "How many goals has Liverpool scored from set pieces?",
  "Which EPL clubs have the strongest pressing metrics?",
  "Who were the top scorers in the latest AFCON tournament?",
  "What are the next AFCON fixtures this week?",
  "Which African national teams are in best form right now?",
  "Who are the standout players in the CAF Champions League?",
  "What are the latest results in the Egyptian Premier League?",
  "Which players are top scorers in the Moroccan Botola Pro?",
  "Which African players are performing best in Europe this season?",
  "What are Manchester City's next three matches?",
  "What are Chelsea's current injury concerns and return windows?",
  "What is Tottenham's likely lineup for the next match?",
  "Summarize Manchester United's last five results.",
  "Which clubs are leading the EPL title race right now?",
  "Which teams are most at risk in the relegation battle?",
  "Who are the best U21 performers in the EPL this season?",
  "Which players have the most yellow cards this season?",
  "Who leads the league in successful dribbles?",
  "Which team has the best chance-conversion rate?",
  "Which teams are strongest in second-half performances?",
  "Which clubs have scored the most goals from corners?",
  "Which teams are most likely to keep clean sheets this weekend?",
  "What is the most likely upset result this weekend?",
  "Compare Mohamed Salah and Erling Haaland this season.",
  "Which teams have the toughest upcoming fixture run?",
  "Which teams have the easiest upcoming fixture run?",
  "Who are the top scorers in La Liga this season?",
  "Which teams are leading the Serie A title race?",
  "Which Bundesliga side has the best attack this season?",
  "Which Ligue 1 teams have improved most this month?",
  "Who has the most assists in Serie A right now?",
  "Which Bundesliga players create the most chances?",
  "What are the biggest Champions League fixtures this week?",
  "Which teams are favorites to win the UEFA Champions League?",
  "Who are the top scorers in the UEFA Champions League?",
  "Who are the breakout players in the UEFA Conference League?",
  "How do Real Madrid and Barcelona compare this season?",
  "How do Inter Milan and Juventus compare this season?",
  "What are the biggest football transfer rumors right now?",
];

const pickRandomPrompts = (prompts: string[], count: number): string[] => {
  const shuffled = [...prompts];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
};

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [contextPrompts, setContextPrompts] = useState<string[]>(() =>
    pickRandomPrompts(CONTEXT_PROMPTS, 5),
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const refreshPrompts = () => setContextPrompts(pickRandomPrompts(CONTEXT_PROMPTS, 5));

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const rotationInterval = setInterval(() => {
      refreshPrompts();
    }, 15000);
    return () => clearInterval(rotationInterval);
  }, []);

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
    } catch {
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
      refreshPrompts();
    }
  };

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden bg-gradient-to-b from-stone-100 via-white to-emerald-50/40 text-neutral-900">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_16%_18%,rgba(16,185,129,0.12),transparent_22%),radial-gradient(circle_at_88%_6%,rgba(15,23,42,0.08),transparent_28%)]" />
      <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-8 sm:px-8 lg:px-12 lg:py-10">
        <header className="rounded-3xl border border-neutral-900/20 bg-white/85 p-6 shadow-[0_16px_40px_-24px_rgba(15,23,42,0.7)] backdrop-blur sm:p-7">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-5">
            <Image
              src={Vector11Logo}
              alt="Vector11 Logo"
              width={190}
              priority
            />
            <div className="border-l-2 border-emerald-600 pl-5">
              <p className="text-xs font-mono uppercase tracking-[0.24em] text-emerald-700">
                Matchday Intelligence
              </p>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                Vector11 AI Chat
              </h1>
              <p className="mt-2 max-w-xl text-sm text-neutral-600">
                Ask tactical football questions across EPL, Africa, and European competitions.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-[0.14em] text-neutral-700">
            <span className="rounded-full border border-neutral-300 bg-white px-3 py-1">
              Football Only
            </span>
            <span className="rounded-full border border-neutral-300 bg-white px-3 py-1">
              50 Prompt Bank
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-700">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              Live
            </span>
          </div>
          </div>
        </header>

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
                  Ask for fixtures, form trends, or match previews. The
                  assistant stays on the black-and-white brief.
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
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
                      <div className="prose-v11 mt-2">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            table: ({ children }) => (
                              <div className="table-wrap">
                                <table>{children}</table>
                              </div>
                            ),
                          }}
                        >
                          {message.content}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <p className="mt-2 whitespace-pre-wrap">
                        {message.content}
                      </p>
                    )}
                  </div>
                ))
              )}
              {isLoading && (
                <div className="max-w-[85%] rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-neutral-900 shadow-sm">
                  <p className="text-[10px] font-mono uppercase tracking-[0.16em] opacity-80">
                    Vector11
                  </p>
                  <div
                    className="mt-2 flex items-center gap-2 text-sm text-neutral-700"
                    role="status"
                    aria-live="polite"
                    aria-label="Vector11 is thinking"
                  >
                    Thinking
                    <span className="inline-flex gap-1">
                      <span className="animate-bounce text-base [animation-delay:0ms]">&#9917;</span>
                      <span className="animate-bounce text-base [animation-delay:150ms]">&#9917;</span>
                      <span className="animate-bounce text-base [animation-delay:300ms]">&#9917;</span>
                    </span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
            <form
              onSubmit={handleSubmit}
              className="border-t border-neutral-200 bg-neutral-50/80 p-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Ask about a club, match, or rumor..."
                  className="flex-1 rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm outline-none transition placeholder:text-neutral-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                />
                <button
                  type="submit"
                  disabled={isLoading}
                  className="group inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-neutral-900 bg-neutral-900 px-6 py-3 text-sm font-mono uppercase tracking-[0.18em] text-white transition hover:-translate-y-0.5 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isLoading ? "Sending" : "Send"}
                  <span className="opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100">
                    →
                  </span>
                </button>
              </div>
            </form>
          </div>

          <aside className="sticky top-6 flex h-fit flex-col gap-5 rounded-3xl border border-neutral-900/20 bg-white/90 p-5 shadow-[0_20px_50px_-28px_rgba(15,23,42,0.75)] backdrop-blur sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-mono uppercase tracking-[0.2em] text-neutral-900">
                Prompt Board
              </h3>
                <p className="mt-2 text-sm text-neutral-600">
                Bold, monochrome guidance to keep responses short and tactical.
              </p>
              </div>
              <button
                type="button"
                onClick={refreshPrompts}
                className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs font-mono uppercase tracking-[0.15em] text-neutral-700 transition hover:border-neutral-400 hover:bg-neutral-100"
              >
                Shuffle
              </button>
            </div>
            <div className="flex flex-col gap-3">
              <p className="text-xs font-mono uppercase tracking-[0.16em] text-neutral-500">
                Context Prompt Cards (5 Random)
              </p>
              {contextPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setInput(prompt)}
                  className="group flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-left text-sm leading-relaxed text-neutral-800 transition hover:-translate-y-0.5 hover:border-neutral-400 hover:bg-neutral-50"
                >
                  <span className="normal-case">{prompt}</span>
                  <span className="mt-1 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100">
                    →
                  </span>
                </button>
              ))}
            </div>
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
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
