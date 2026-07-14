/**
 * Replaces packages/backend/server/src/base/cache/{provider,instances}.ts.
 *
 * The original is a pure ioredis wrapper — no NestJS-specific logic beyond
 * DI injection of a Redis instance. Verified (web search, not assumed)
 * that Vercel KV is dead (sunset, docs removed, transitioned to the
 * Marketplace) and Upstash for Redis is the recommended replacement on
 * Vercel — AND that Upstash speaks the real Redis wire protocol over TCP
 * (`rediss://`), not just its HTTP/REST client, so ioredis works against it
 * completely unchanged. That means this port is close to verbatim: same
 * class, same method set, just pointed at UPSTASH_REDIS_URL instead of a
 * NestJS-managed ioredis instance.
 *
 * Two named instances mirror the original's `Cache` (general) and
 * `SessionCache` (session-scoped) — same idea, just two Redis DB numbers /
 * key prefixes instead of two DI tokens.
 *
 * FIX (found while wiring packages/ai/src/models.ts's dynamic model catalog
 * cache): `cache`/`sessionCache` used to construct their Redis connection
 * EAGERLY at module load (`new CacheProvider(redisFor(process.env...))`),
 * which THROWS immediately if UPSTASH_REDIS_URL isn't set — identical bug
 * class to the Prisma eager-client issue fixed in packages/db/src/db.ts
 * during Phase 2 (breaks `next build`'s page-data collection, and now would
 * also break any package that merely `import`s this one, like models.ts,
 * even when it never actually needs the cache). Fixed the same way: lazy
 * Proxy, connects only on first real use.
 */
import Redis from 'ioredis';

export interface CacheSetOptions {
  /** in milliseconds */
  ttl?: number;
}

export class CacheProvider {
  constructor(private readonly redis: Redis) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.redis
      .get(key)
      .then(v => (v ? JSON.parse(v) : undefined))
      .catch(() => undefined);
  }

  async set<T = unknown>(key: string, value: T, opts: CacheSetOptions = {}): Promise<boolean> {
    if (opts.ttl) {
      return this.redis
        .set(key, JSON.stringify(value), 'PX', opts.ttl)
        .then(() => true)
        .catch(() => false);
    }
    return this.redis
      .set(key, JSON.stringify(value))
      .then(() => true)
      .catch(() => false);
  }

  async increase(key: string, count = 1): Promise<number> {
    return this.redis.incrby(key, count).catch(() => 0);
  }

  async decrease(key: string, count = 1): Promise<number> {
    return this.redis.decrby(key, count).catch(() => 0);
  }

  async setnx<T = unknown>(key: string, value: T, opts: CacheSetOptions = {}): Promise<boolean> {
    if (opts.ttl) {
      return this.redis
        .set(key, JSON.stringify(value), 'PX', opts.ttl, 'NX')
        .then(v => !!v)
        .catch(() => false);
    }
    return this.redis
      .set(key, JSON.stringify(value), 'NX')
      .then(v => !!v)
      .catch(() => false);
  }

  async delete(key: string): Promise<boolean> {
    return this.redis
      .del(key)
      .then(() => true)
      .catch(() => false);
  }

  async mapSet(map: string, field: string, value: unknown): Promise<boolean> {
    return this.redis
      .hset(map, field, JSON.stringify(value))
      .then(() => true)
      .catch(() => false);
  }

  async mapGet<T = unknown>(map: string, field: string): Promise<T | undefined> {
    return this.redis
      .hget(map, field)
      .then(v => (v ? JSON.parse(v) : undefined))
      .catch(() => undefined);
  }

  async mapDelete(map: string, field: string): Promise<boolean> {
    return this.redis
      .hdel(map, field)
      .then(() => true)
      .catch(() => false);
  }

  async mapRandomKey(map: string): Promise<string | undefined> {
    return this.redis
      .hrandfield(map, 1)
      .then(v => (typeof v === 'string' ? v : Array.isArray(v) ? (v[0] as string) : undefined))
      .catch(() => undefined);
  }

  async mapLen(map: string): Promise<number> {
    return this.redis.hlen(map).catch(() => 0);
  }
}

function redisFor(url: string | undefined, label: string): Redis {
  if (!url) throw new Error(`${label} is not set (expected an Upstash Redis rediss:// connection string)`);
  return new Redis(url, { tls: url.startsWith('rediss://') ? {} : undefined, maxRetriesPerRequest: 3 });
}

/**
 * Lazy Proxy: only calls `redisFor` (which throws on a missing env var) the
 * first time a real method is actually invoked, not at import/module-eval
 * time. Every subsequent access reuses the same connection.
 */
function lazyCacheProvider(urlEnv: string, fallbackEnv: string | undefined, label: string): CacheProvider {
  let instance: CacheProvider | null = null;
  const getInstance = () => {
    if (!instance) {
      // Prefer the explicit UPSTASH_REDIS_URL/UPSTASH_REDIS_SESSION_URL names
      // (what this module was originally written against), but fall back to
      // whatever a Vercel-native Redis integration actually injects when you
      // "Connect" a Redis/Upstash resource to a project from the dashboard
      // (Vercel's own KV/Upstash Marketplace integration sets REDIS_URL /
      // KV_URL, not UPSTASH_REDIS_URL — both are real ioredis-compatible
      // rediss:// connection strings, so this is a safe rename, not a
      // behavior change).
      const url =
        process.env[urlEnv] ??
        (fallbackEnv ? process.env[fallbackEnv] : undefined) ??
        process.env.REDIS_URL ??
        process.env.KV_URL;
      instance = new CacheProvider(redisFor(url, label));
    }
    return instance;
  };
  return new Proxy({} as CacheProvider, {
    get(_target, prop, receiver) {
      const inst = getInstance();
      const value = Reflect.get(inst as object, prop, receiver);
      return typeof value === 'function' ? value.bind(inst) : value;
    },
  });
}

/** General-purpose cache (rate limits, feature flags, misc key/value). Connects lazily on first use. */
export const cache = lazyCacheProvider('UPSTASH_REDIS_URL', undefined, 'UPSTASH_REDIS_URL');

/** Session-scoped cache — same Redis, separate connection/key space (mirrors the original's SessionCache). Connects lazily on first use. */
export const sessionCache = lazyCacheProvider('UPSTASH_REDIS_SESSION_URL', 'UPSTASH_REDIS_URL', 'UPSTASH_REDIS_SESSION_URL');

export { Redis };

/**
 * Raw ioredis client accessor, lazy like the CacheProviders above — needed
 * by consumers that must speak a foreign wire-protocol string contract
 * directly (e.g. packages/auth's Better Auth `secondaryStorage` adapter,
 * whose interface is `get(key): Promise<unknown>` /
 * `set(key, value: string, ttl?)` / `delete(key)` — NOT the JSON-wrapping
 * CacheProvider methods, which would double-encode values Better Auth
 * already serializes itself). Reuses the same UPSTASH_REDIS_URL connection
 * env var as the general `cache` instance, but as its own lazy singleton
 * so it only connects if something actually calls it.
 */
let rawRedisInstance: Redis | null = null;
export function getRawRedis(): Redis {
  if (!rawRedisInstance) {
    const url = process.env.UPSTASH_REDIS_URL ?? process.env.REDIS_URL ?? process.env.KV_URL;
    rawRedisInstance = redisFor(url, 'UPSTASH_REDIS_URL');
  }
  return rawRedisInstance;
}
