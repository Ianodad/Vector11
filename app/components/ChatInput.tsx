// Chat input form component

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  isLoading: boolean;
}

export const ChatInput = ({ value, onChange, onSubmit, isLoading }: ChatInputProps) => {
  return (
    <form
      onSubmit={onSubmit}
      className="border-t border-neutral-200 bg-neutral-50/80 p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
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
  );
};
