// Loading indicator with bouncing football animation

export const LoadingIndicator = () => {
  return (
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
  );
};
