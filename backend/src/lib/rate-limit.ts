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
export const RATE_LIMITED_BODY = { error: "Too Many Requests", code: "RATE_LIMITED" } as const;

function sendRateLimited(reply: FastifyReply, retryAfterMs: number) {
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

export function adminRateLimit(options: Omit<RateLimitOptions, "keyGenerator">) {
  return rateLimit({
    ...options,
    keyGenerator: (request) => {
      const admin = (request as AdminScopedRequest).admin;
      return `admin:${admin?.id ?? getClientIp(request)}`;
    },
  });
}
