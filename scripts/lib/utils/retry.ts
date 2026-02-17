// Retry logic with exponential backoff

export const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

export const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

export const withRetry = async <T>(
  operationName: string,
  fn: () => Promise<T>,
  attempts: number,
  baseDelayMs: number,
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `[retry] ${operationName} failed (attempt ${attempt}/${attempts}): ${getErrorMessage(error)}. Retrying in ${delayMs}ms`,
      );
      await sleepMs(delayMs);
    }
  }

  throw lastError;
};
