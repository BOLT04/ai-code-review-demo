const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

export async function withRateLimitRetries<T>(
  operation: () => Promise<T>,
  maxRetries: number,
  onRetry: (retry: number, delayMs: number) => void,
  sleep: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/\b429\b/.test(message) || retry >= maxRetries) throw error;

      const delayMs = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** retry, MAX_RETRY_DELAY_MS);
      onRetry(retry + 1, delayMs);
      await sleep(delayMs);
    }
  }
}
