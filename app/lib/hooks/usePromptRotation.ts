// Custom hook for rotating prompt suggestions
import { useState, useEffect, useRef } from "react";
import { CONTEXT_PROMPTS } from "../constants";
import { pickRandomPrompts } from "../utils";

export const usePromptRotation = (count = 5, intervalMs = 15000) => {
  // Rotation pool: starts as the static fallback list, swapped out on mount
  // if /api/prompts returns a non-empty corpus-driven list.
  const promptPoolRef = useRef<readonly string[]>(CONTEXT_PROMPTS);
  const [contextPrompts, setContextPrompts] = useState<string[]>(() =>
    pickRandomPrompts(CONTEXT_PROMPTS, count),
  );

  const refreshPrompts = () => {
    setContextPrompts(pickRandomPrompts(promptPoolRef.current, count));
  };

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const response = await fetch("/api/prompts", { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json();
        if (Array.isArray(data?.prompts) && data.prompts.length > 0) {
          promptPoolRef.current = data.prompts;
          setContextPrompts(pickRandomPrompts(data.prompts, count));
        }
      } catch {
        // Ignore — keep the static CONTEXT_PROMPTS fallback pool.
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const rotationInterval = setInterval(refreshPrompts, intervalMs);
    return () => clearInterval(rotationInterval);
  }, [intervalMs]);

  return { contextPrompts, refreshPrompts };
};
