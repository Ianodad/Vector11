// Loading indicator with bouncing football animation
import { useEffect, useState } from "react";

interface LoadingIndicatorProps {
  label?: string;
}

export const LoadingIndicator = ({ label = "Thinking" }: LoadingIndicatorProps) => {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="max-w-[85%] rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-neutral-900 shadow-sm">
      <p className="text-[10px] font-mono uppercase tracking-[0.16em] opacity-80">
        Vector11
      </p>
      <div
        className="mt-2 flex items-center gap-2 text-sm text-neutral-700"
        role="status"
        aria-live="polite"
        aria-label={`Vector11: ${label}`}
      >
        {label}
        <span className="inline-flex gap-1">
          <span className="animate-bounce text-base [animation-delay:0ms]">&#9917;</span>
          <span className="animate-bounce text-base [animation-delay:150ms]">&#9917;</span>
          <span className="animate-bounce text-base [animation-delay:300ms]">&#9917;</span>
        </span>
      </div>
      {slow && (
        <p className="mt-1 text-xs text-neutral-500">
          Still working &mdash; the database may be waking up.
        </p>
      )}
    </div>
  );
};
