// Banner shown under the chat header while the stats database wakes from hibernation
import { useEffect, useState } from "react";
import type { DbStatus } from "../lib/hooks/useDbStatus";

// Only show the banner for "checking" if it lasts this long (avoids a flash on a warm DB)
const CHECKING_DELAY_MS = 1500;

interface DbStatusBannerProps {
  status: DbStatus;
  justWoke: boolean;
  wakingSince: number | null;
}

const formatElapsed = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};

export const DbStatusBanner = ({ status, justWoke, wakingSince }: DbStatusBannerProps) => {
  const [now, setNow] = useState(() => Date.now());
  // status the delay timer fired for; the banner only shows if it still matches
  const [delayedFor, setDelayedFor] = useState<DbStatus | null>(null);

  const waking = status === "waking";
  const slow = status === "slow";
  const checking = status === "checking" && delayedFor === "checking";
  const ready = justWoke && status === "ready";

  useEffect(() => {
    if (status !== "checking") return;
    const timer = setTimeout(() => setDelayedFor("checking"), CHECKING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (!waking) return;
    // first tick via 0ms timeout so a new waking period doesn't show a stale frame
    const first = setTimeout(() => setNow(Date.now()), 0);
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [waking]);

  if (!checking && !waking && !slow && !ready) return null;

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
              : waking
                ? "Warming up the stats database"
                : "Checking the stats database"}
        </p>
        {checking && (
          <p className="mt-0.5 text-neutral-700">
            Send unlocks as soon as the database responds.
          </p>
        )}
        {waking && (
          <>
            {wakingSince !== null && (
              <p aria-hidden="true" className="mt-0.5 font-mono text-neutral-900">
                Waiting {formatElapsed(now - wakingSince)} &middot; usually under a minute
              </p>
            )}
            <p className="mt-0.5 text-neutral-700">
              It sleeps when nobody&apos;s asking. You can type your question now
              &mdash; Send unlocks automatically when the database is ready.
            </p>
          </>
        )}
        {slow && (
          <p className="mt-0.5 text-neutral-700">
            This is taking longer than usual. Send is unlocked, but answers may be slow.
          </p>
        )}
      </div>
    </div>
  );
};
