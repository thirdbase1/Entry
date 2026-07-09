/**
 * Minimal stand-in for the original's `Cache` (base/cache.ts, Redis-backed
 * via NestJS DI). Used only by todo.ts right now. In-process Map for this
 * scaffold — Phase 2 TODO: back with the real Redis/Cache layer so todo
 * lists survive across server instances, same caveat as kernel.ts's
 * session map.
 */
const store = new Map<string, unknown>();

export const memoryCache = {
  async get<T>(key: string): Promise<T | undefined> {
    return store.get(key) as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    store.set(key, value);
  },
};
