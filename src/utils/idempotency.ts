// src/utils/idempotency.ts
const store = new Map<string, Promise<any>>();

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Request is already being processed");
  }
}

export async function withIdempotency<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = store.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  const promise = (async () => {
    try {
      return await fn();
    } finally {
      // Keep the result cached briefly to dedupe rapid retries
      setTimeout(() => store.delete(key), 10_000);
    }
  })();
  store.set(key, promise);
  return promise;
}
