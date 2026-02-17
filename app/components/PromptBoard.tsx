// Sidebar with rotating prompt suggestions

interface PromptBoardProps {
  prompts: string[];
  onPromptClick: (prompt: string) => void;
  onRefresh: () => void;
}

export const PromptBoard = ({ prompts, onPromptClick, onRefresh }: PromptBoardProps) => {
  return (
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
          onClick={onRefresh}
          className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs font-mono uppercase tracking-[0.15em] text-neutral-700 transition hover:border-neutral-400 hover:bg-neutral-100"
        >
          Shuffle
        </button>
      </div>
      <div className="flex flex-col gap-3">
        <p className="text-xs font-mono uppercase tracking-[0.16em] text-neutral-500">
          Context Prompt Cards (5 Random)
        </p>
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onPromptClick(prompt)}
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
        <p className="text-xs font-mono uppercase tracking-[0.2em]">Status</p>
        <p className="mt-2 text-sm">
          Data sources refreshed from recent feeds and stat tables.
        </p>
      </div>
    </aside>
  );
};
