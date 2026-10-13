// Banner shown under the chat header while the stats database wakes from hibernation
import type { DbStatus } from "../lib/hooks/useDbStatus";

interface DbStatusBannerProps {
  status: DbStatus;
  justWoke: boolean;
}

export const DbStatusBanner = ({ status, justWoke }: DbStatusBannerProps) => {
  const waking = status === "waking";
  const slow = status === "slow";
  const ready = justWoke && status === "ready";
  if (!waking && !slow && !ready) return null;

  const tone = slow
    ? "border-amber-200 bg-amber-50 text-amber-900"
    : "border-emerald-200 bg-emerald-50 text-emerald-900";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-3 border-b px-5 py-2.5 text-xs ${tone}`}
    >
      {ready ? (
        <span aria-hidden className="mt-0.5 text-emerald-600">&#10003;</span>
      ) : (
        <span
          aria-hidden
          className={`mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full ${
            slow ? "bg-amber-500" : "bg-emerald-500"
          }`}
        />
      )}
      <div className="min-w-0">
        <p className="font-mono uppercase tracking-[0.16em]">
          {ready
            ? "Stats database ready"
            : slow
              ? "Still waking up"
              : "Warming up the stats database"}
        </p>
        {waking && (
          <p className="mt-0.5 text-neutral-700">
            It sleeps when nobody&apos;s asking. This usually takes under a minute
            &mdash; you can type your question now.
          </p>
        )}
        {slow && (
          <p className="mt-0.5 text-neutral-700">
            Still waking up. Answers may take a little longer than usual.
          </p>
        )}
      </div>
    </div>
  );
};
