// app/lib/astraResume.ts
// The NVIDIA reranker is a separate service from the database. Its failures must fall back
// to plain vector search, not be reported to the user as a hibernating database.
export const isRerankerError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return /rerank/i.test(msg);
};

// Serverless Astra hibernates when idle; the first request after a pause fails
// with a 503 "Resuming your database". Retry only that transient class so a cold
// DB no longer returns a confident but empty answer to the first user of the day.
export const isDbResumingError = (err: unknown): boolean => {
  if (isRerankerError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /resum|hibernat|503|not (yet )?ready|starting|initializ|unavailable_database|not enough (nodes|replicas)|refused to start processing|quorum|safe to retry/i
    .test(msg);
};

export const withDbResumeRetry = async <T>(
  op: () => Promise<T>,
  attempts = 8,
  baseDelayMs = 1500,
): Promise<T> => {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (i === attempts || !isDbResumingError(err)) throw err;
      const delayMs = Math.min(baseDelayMs * i, 8000);
      console.log(`[chat] DB resuming — retry ${i}/${attempts} in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
};
