// Custom hook for rotating prompt suggestions
import { useState, useEffect } from "react";
import { CONTEXT_PROMPTS } from "../constants";
import { pickRandomPrompts } from "../utils";

export const usePromptRotation = (count = 5, intervalMs = 15000) => {
  const [contextPrompts, setContextPrompts] = useState<string[]>(() =>
    pickRandomPrompts(CONTEXT_PROMPTS, count),
  );

  const refreshPrompts = () => {
    setContextPrompts(pickRandomPrompts(CONTEXT_PROMPTS, count));
  };

  useEffect(() => {
    const rotationInterval = setInterval(refreshPrompts, intervalMs);
    return () => clearInterval(rotationInterval);
  }, [intervalMs]);

  return { contextPrompts, refreshPrompts };
};
