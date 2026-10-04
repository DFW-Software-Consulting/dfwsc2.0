import type { FastifyReply, FastifyRequest } from "fastify";
import Redis from "ioredis";
import { getClientIp } from "./client-ip";

type RateLimitOptions = {
  max: number;
  windowMs: number;
  // Bucket namespace. Defaults to the request's method and route pattern so
  // limiters on different routes never share (or prune) each other's hits.
  name?: string;
  keyGenerator?: (request: FastifyRequest) => string;
  maxGenerator?: (request: FastifyRequest) => number;
};

type AdminScopedRequest = FastifyRequest & { admin?: { id?: string } };

let redis: Redis | null = null;

try {
  if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    redis.on("error", () => {});
  }
} catch {
  redis = null;
}

// One-time startup signal: without REDIS_URL, rate limiting silently falls back
// to the per-process in-memory buckets below. That's fine for a single instance,
// but under horizontal scaling every limit is effectively multiplied by the
// number of replicas, since each process tracks its own hit counts. Called once
// from createServer with the app logger so it surfaces at boot.
export function warnIfInMemoryRateLimit(logger: { warn: (msg: string) => void }): void {
  if (redis) return;
  logger.warn(
    "[rate-limit] REDIS_URL is not set — rate limiting is falling back to per-process " +
      "in-memory buckets. Limits are NOT shared across replicas: horizontally scaling " +
      "this service multiplies every limit by the replica count. Set REDIS_URL to enable " +
      "shared, Redis-backed rate limiting."
  );
}

// Redis failures are logged at most once per interval so an outage does not
// produce one error line per request.
const REDIS_ERROR_LOG_INTERVAL_MS = 30_000;
let lastRedisErrorLogAt = 0;

function logRedisFailure(request: FastifyRequest, err: unknown): void {
  const now = Date.now();
  if (now - lastRedisErrorLogAt < REDIS_ERROR_LOG_INTERVAL_MS) return;
  lastRedisErrorLogAt = now;
  request.log.error(
    { err },
    "Rate limiter Redis error; falling back to in-memory limits until Redis recovers"
  );
}

// Every refusal from our own limiters carries the same body and a Retry-After in whole
// seconds (at least 1) so a caller can wait exactly as long as needed and retry.
const RATE_LIMITED_BODY = { error: "Too Many Requests", code: "RATE_LIMITED" } as const;

export function sendRateLimited(reply: FastifyReply, retryAfterMs: number) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return reply
    .code(429)
    .header("Retry-After", String(seconds))
    .send({ ...RATE_LIMITED_BODY });
}

function limiterNamespace(request: FastifyRequest, name?: string): string {
  if (name) return name;
  const route = request.routeOptions?.url;
  // Fastify serves HEAD from every GET route, so both share one bucket.
  const method = request.method === "HEAD" ? "GET" : request.method;
  return route ? `${method}:${route}` : "default";
}

export const hitBuckets = new Map<string, number[]>();
type TokenBucketState = { tokens: number; updatedAt: number; fullRefillMs: number };
export const tokenBuckets = new Map<string, TokenBucketState>();
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let maxRegisteredWindowMs = 0;
setInterval(() => {
  const bucketMaxAge =
    maxRegisteredWindowMs > 0 ? maxRegisteredWindowMs + SWEEP_INTERVAL_MS : 20 * 60 * 1000;
  const cutoff = Date.now() - bucketMaxAge;
  for (const [key, hits] of hitBuckets) {
    if (hits.every((t) => t < cutoff)) {
      hitBuckets.delete(key);
    }
  }
  const now = Date.now();
  for (const [key, bucket] of tokenBuckets) {
    // A bucket that has had time to refill completely behaves like a new one.
    if (now - bucket.updatedAt >= bucket.fullRefillMs) {
      tokenBuckets.delete(key);
    }
  }
}, SWEEP_INTERVAL_MS).unref();

type SlidingWindowResult = { allowed: true } | { allowed: false; retryAfterMs: number };

async function redisSlidingWindow(
  client: Redis,
  key: string,
  maxHits: number,
  windowMs: number
): Promise<SlidingWindowResult> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const pipeline = client.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zcard(key);
  pipeline.zadd(key, now.toString(), `${now}:${Math.random()}`);
  pipeline.pexpire(key, windowMs);
  const results = await pipeline.exec();
  if (!results) throw new Error("Redis pipeline returned no results");
  // ioredis resolves with per-command errors rather than rejecting when the
  // connection is down, so surface them here.
  const failed = results.find(([err]) => err);
  if (failed) throw failed[0];
  const count = results[1]?.[1] as number;
  if (count >= maxHits) {
    await client.zremrangebyscore(key, now, now);
    return {
      allowed: false,
      retryAfterMs: await redisOldestHitExpiryMs(client, key, now, windowMs),
    };
  }
  return { allowed: true };
}

// Time until the oldest counted hit leaves the window. A failure to read it must not turn
// a refusal into a Redis error (which would fall back to memory and let the request
// through), so it degrades to the full window, which is always a safe upper bound.
async function redisOldestHitExpiryMs(
  client: Redis,
  key: string,
  now: number,
  windowMs: number
): Promise<number> {
  try {
    const oldest = await client.zrange(key, 0, 0, "WITHSCORES");
    const score = Number(oldest[1]);
    if (Number.isFinite(score)) return score + windowMs - now;
  } catch {
    // fall through to the conservative default
  }
  return windowMs;
}

type TokenBucketOptions = {
  /** Largest burst: the bucket holds at most this many tokens and starts full. */
  capacity: number;
  /** Sustained rate: tokens added back per minute. */
  refillPerMinute: number;
  // Bucket namespace, as for the sliding window.
  name?: string;
  keyGenerator?: (request: FastifyRequest) => string;
};

type TokenBucketResult = { allowed: true } | { allowed: false; retryAfterMs: number };

// Atomic take of one token. The refill is computed from Redis's own clock (TIME) so replicas
// with skewed clocks agree, and the whole read-refill-take-write runs inside one script so
// concurrent requests can never both take the last token.
//   KEYS[1] bucket hash (fields: tokens, ts)
//   ARGV[1] capacity, ARGV[2] refill tokens per millisecond, ARGV[3] key TTL in ms
// Returns { allowed (1/0), retryAfterMs }.
export const TOKEN_BUCKET_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * rate)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttl)
return { allowed, retry }
`;

async function redisTokenBucket(
  client: Redis,
  key: string,
  capacity: number,
  refillPerMs: number,
  fullRefillMs: number
): Promise<TokenBucketResult> {
  const reply = (await client.eval(
    TOKEN_BUCKET_LUA,
    1,
    key,
    String(capacity),
    String(refillPerMs),
    // Keep the key until the bucket would be full again, plus slack; after that a missing
    // key and a full bucket are the same thing.
    String(Math.ceil(fullRefillMs) + 1000)
  )) as [number, number] | null;
  if (!Array.isArray(reply)) throw new Error("Redis token bucket script returned no result");
  const [allowed, retryAfterMs] = reply;
  return Number(allowed) === 1 ? { allowed: true } : { allowed: false, retryAfterMs };
}

function memoryTokenBucket(
  key: string,
  capacity: number,
  refillPerMs: number,
  fullRefillMs: number,
  now: number
): TokenBucketResult {
  const bucket = tokenBuckets.get(key) ?? { tokens: capacity, updatedAt: now, fullRefillMs };
  const elapsed = Math.max(0, now - bucket.updatedAt);
  const tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
  if (tokens >= 1) {
    tokenBuckets.set(key, { tokens: tokens - 1, updatedAt: now, fullRefillMs });
    return { allowed: true };
  }
  tokenBuckets.set(key, { tokens, updatedAt: now, fullRefillMs });
  return { allowed: false, retryAfterMs: Math.ceil((1 - tokens) / refillPerMs) };
}

/**
 * Token-bucket limiter: absorbs a burst of up to `capacity` requests, then admits requests at
 * `refillPerMinute` on average. Same shape as `rateLimit`: per-route namespacing, a Redis
 * implementation (atomic Lua script) with an in-memory fallback when Redis errors. A refusal
 * is a 429 whose Retry-After is the time until one token is available.
 */
export function tokenBucketRateLimit(options: TokenBucketOptions) {
  const { capacity, refillPerMinute } = options;
  if (!(capacity >= 1) || !(refillPerMinute > 0)) {
    throw new Error("tokenBucketRateLimit requires capacity >= 1 and refillPerMinute > 0");
  }
  const refillPerMs = refillPerMinute / 60_000;
  const fullRefillMs = capacity / refillPerMs;

  return async function tokenBucketGuard(request: FastifyRequest, reply: FastifyReply) {
    const id = options.keyGenerator ? options.keyGenerator(request) : getClientIp(request);
    // Own key prefix: a Redis hash must never share a key with a sliding-window sorted set.
    const key = `ratelimit:bucket:${limiterNamespace(request, options.name)}:${id}`;

    let result: TokenBucketResult | undefined;
    if (redis) {
      try {
        result = await redisTokenBucket(redis, key, capacity, refillPerMs, fullRefillMs);
      } catch (err) {
        // Same stance as the sliding window: a single instance is as accurate in memory, and
        // failing closed would reject payments whenever Redis restarts.
        logRedisFailure(request, err);
      }
    }
    result ??= memoryTokenBucket(key, capacity, refillPerMs, fullRefillMs, Date.now());

    if (!result.allowed) {
      return sendRateLimited(reply, result.retryAfterMs);
    }
  };
}

export function rateLimit(options: RateLimitOptions) {
  const { max, windowMs } = options;
  maxRegisteredWindowMs = Math.max(maxRegisteredWindowMs, windowMs);

  return async function rateLimitGuard(request: FastifyRequest, reply: FastifyReply) {
    const id = options.keyGenerator ? options.keyGenerator(request) : getClientIp(request);
    const key = `ratelimit:${limiterNamespace(request, options.name)}:${id}`;
    const maxForRequest = options.maxGenerator ? options.maxGenerator(request) : max;

    if (redis) {
      try {
        const result = await redisSlidingWindow(redis, key, maxForRequest, windowMs);
        if (!result.allowed) {
          return sendRateLimited(reply, result.retryAfterMs);
        }
        return;
      } catch (err) {
        // Single API instance: the in-memory limiter is as accurate as Redis,
        // and failing closed would reject payments whenever Redis restarts.
        logRedisFailure(request, err);
      }
    }

    const now = Date.now();
    const windowStart = now - windowMs;
    const hits = hitBuckets.get(key) ?? [];
    const recentHits = hits.filter((timestamp) => timestamp > windowStart);
    if (recentHits.length >= maxForRequest) {
      hitBuckets.set(key, recentHits);
      // Hits are appended in time order, so the first is the oldest counted one.
      return sendRateLimited(reply, (recentHits[0] ?? now) + windowMs - now);
    }
    recentHits.push(now);
    hitBuckets.set(key, recentHits);
  };
}

type FailureLimiterOptions = {
  /** Failures allowed per window; the next request after that is refused. */
  max: number;
  windowMs: number;
  // Bucket namespace, as for the sliding window.
  name?: string;
  keyGenerator?: (request: FastifyRequest) => string;
};

type FailureCheckResult = { blocked: false } | { blocked: true; retryAfterMs: number };

/**
 * Counts failures (for example failed authentications) per key, separately from deciding
 * whether to refuse. `check` reads the count without charging anything; `record` charges one
 * failure. Unlike `rateLimit`, a request that succeeds is never counted, and a refusal is not
 * counted either, so the window drains on its own. Same storage as `rateLimit`: a Redis sorted
 * set (in-memory fallback when Redis errors), namespaced by `name`. The check and the record are
 * separate calls, so a burst of concurrent requests can overshoot `max` slightly.
 */
export function failureRateLimit(options: FailureLimiterOptions) {
  const { max, windowMs } = options;
  maxRegisteredWindowMs = Math.max(maxRegisteredWindowMs, windowMs);

  function keyFor(request: FastifyRequest): string {
    const id = options.keyGenerator ? options.keyGenerator(request) : getClientIp(request);
    return `ratelimit:${limiterNamespace(request, options.name)}:${id}`;
  }

  async function redisCheck(client: Redis, key: string, now: number): Promise<FailureCheckResult> {
    const pipeline = client.pipeline();
    pipeline.zremrangebyscore(key, 0, now - windowMs);
    pipeline.zcard(key);
    pipeline.zrange(key, 0, 0, "WITHSCORES");
    const results = await pipeline.exec();
    if (!results) throw new Error("Redis pipeline returned no results");
    const failed = results.find(([err]) => err);
    if (failed) throw failed[0];
    const count = Number(results[1]?.[1]);
    if (count < max) return { blocked: false };
    const oldest = Number((results[2]?.[1] as string[] | undefined)?.[1]);
    return {
      blocked: true,
      retryAfterMs: Number.isFinite(oldest) ? oldest + windowMs - now : windowMs,
    };
  }

  function memoryCheck(key: string, now: number): FailureCheckResult {
    const recent = (hitBuckets.get(key) ?? []).filter((t) => t > now - windowMs);
    hitBuckets.set(key, recent);
    if (recent.length < max) return { blocked: false };
    return { blocked: true, retryAfterMs: (recent[0] ?? now) + windowMs - now };
  }

  return {
    async check(request: FastifyRequest): Promise<FailureCheckResult> {
      const key = keyFor(request);
      const now = Date.now();
      if (redis) {
        try {
          return await redisCheck(redis, key, now);
        } catch (err) {
          logRedisFailure(request, err);
        }
      }
      return memoryCheck(key, now);
    },

    async record(request: FastifyRequest): Promise<void> {
      const key = keyFor(request);
      const now = Date.now();
      if (redis) {
        try {
          const pipeline = redis.pipeline();
          pipeline.zadd(key, now.toString(), `${now}:${Math.random()}`);
          pipeline.pexpire(key, windowMs);
          const results = await pipeline.exec();
          if (!results) throw new Error("Redis pipeline returned no results");
          const failed = results.find(([err]) => err);
          if (failed) throw failed[0];
          return;
        } catch (err) {
          logRedisFailure(request, err);
        }
      }
      const hits = (hitBuckets.get(key) ?? []).filter((t) => t > now - windowMs);
      hits.push(now);
      hitBuckets.set(key, hits);
    },
  };
}

export function adminRateLimit(options: Omit<RateLimitOptions, "keyGenerator">) {
  return rateLimit({
    ...options,
    keyGenerator: (request) => {
      const admin = (request as AdminScopedRequest).admin;
      return `admin:${admin?.id ?? getClientIp(request)}`;
    },
  });
}
