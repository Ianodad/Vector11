// Wakes the (hibernating) Astra database on page load and tracks its status.
import { useCallback, useEffect, useRef, useState } from "react";

export type DbStatus = "checking" | "ready" | "waking" | "slow" | "error";

const POLL_INTERVAL_MS = 5000;
const GIVE_UP_MS = 3 * 60 * 1000;
const JUST_WOKE_MS = 4000;

export const useDbStatus = () => {
  const [status, setStatus] = useState<DbStatus>("checking");
  const [justWoke, setJustWoke] = useState(false);
  // epoch ms when the current waking period began (null when not waking/slow)
  const [wakingSince, setWakingSince] = useState<number | null>(null);
  const statusRef = useRef<DbStatus>("checking");
  const pollingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justWokeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakingSinceRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);
  const runIdRef = useRef(0);
  const checkRef = useRef<(runId: number) => Promise<void>>(async () => {});

  const update = useCallback((next: DbStatus) => {
    const prev = statusRef.current;
    statusRef.current = next;
    setStatus(next);
    if (next === "ready" && (prev === "waking" || prev === "slow")) {
      setJustWoke(true);
      if (justWokeTimerRef.current) clearTimeout(justWokeTimerRef.current);
      justWokeTimerRef.current = setTimeout(() => setJustWoke(false), JUST_WOKE_MS);
    }
  }, []);

  const check = useCallback(async (runId: number) => {
    // runId guards against a stale loop (e.g. React strict-mode remount) continuing
    if (unmountedRef.current || runId !== runIdRef.current) return;
    let next: DbStatus = "waking";
    try {
      const res = await fetch("/api/health", {
        cache: "no-store",
        // a hung connection must not leave status stuck on "checking"
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const data = (await res.json()) as { status?: string };
        if (data.status === "ready") next = "ready";
        else if (data.status === "error") next = "error";
      }
    } catch {
      // network failure -> treat as waking and keep polling
    }
    if (unmountedRef.current || runId !== runIdRef.current) return;

    if (next === "ready" || next === "error") {
      pollingRef.current = false;
      wakingSinceRef.current = null;
      setWakingSince(null);
      update(next);
      return;
    }

    wakingSinceRef.current ??= Date.now();
    setWakingSince(wakingSinceRef.current);
    if (Date.now() - wakingSinceRef.current >= GIVE_UP_MS) {
      pollingRef.current = false;
      update("slow");
      return;
    }
    update("waking");
    timerRef.current = setTimeout(() => void checkRef.current(runId), POLL_INTERVAL_MS);
  }, [update]);

  useEffect(() => {
    checkRef.current = check;
  }, [check]);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    runIdRef.current += 1;
    void checkRef.current(runIdRef.current);
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    startPolling();
    return () => {
      unmountedRef.current = true;
      pollingRef.current = false;
      runIdRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (justWokeTimerRef.current) clearTimeout(justWokeTimerRef.current);
    };
  }, [startPolling]);

  const markWaking = useCallback(() => {
    if (pollingRef.current) return;
    wakingSinceRef.current = Date.now();
    setWakingSince(wakingSinceRef.current);
    update("waking");
    startPolling();
  }, [startPolling, update]);

  return { status, justWoke, wakingSince, markWaking };
};
