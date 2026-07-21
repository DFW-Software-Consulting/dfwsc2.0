import type { FastifyReply, FastifyRequest } from "fastify";
import Redis from "ioredis";

type RateLimitOptions = {
  max: number;
  windowMs: number;
  keyGenerator?: (request: FastifyRequest) => string;
  maxGenerator?: (request: FastifyRequest) => number;
};

type AdminScopedRequest = FastifyRequest & { admin?: { id?: string } };

let redis: Redis | null = null;
const isProduction = process.env.NODE_ENV === "production";

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

async function redisSlidingWindow(
  client: Redis,
  key: string,
  maxHits: number,
  windowMs: number
): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const pipeline = client.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zcard(key);
  pipeline.zadd(key, now.toString(), `${now}:${Math.random()}`);
  pipeline.pexpire(key, windowMs);
  const results = await pipeline.exec();
  if (!results) return false;
  const count = results[1]?.[1] as number;
  if (count >= maxHits) {
    await client.zremrangebyscore(key, now, now);
    return false;
  }
  return true;
}

export function rateLimit(options: RateLimitOptions) {
  const { max, windowMs } = options;
  maxRegisteredWindowMs = Math.max(maxRegisteredWindowMs, windowMs);

  return async function rateLimitGuard(request: FastifyRequest, reply: FastifyReply) {
    const key = `ratelimit:${options.keyGenerator ? options.keyGenerator(request) : request.ip || "unknown"}`;
    const maxForRequest = options.maxGenerator ? options.maxGenerator(request) : max;

    if (redis) {
      try {
        const allowed = await redisSlidingWindow(redis, key, maxForRequest, windowMs);
        if (!allowed) {
          return reply.code(429).send({ error: "Too Many Requests" });
        }
        return;
      } catch (err) {
        // In production, fail closed: reject the request rather than silently
        // degrading to in-memory rate limiting. This prevents abuse when Redis
        // is unavailable.
        if (isProduction) {
          request.log.error({ err }, "Rate limiter Redis error; rejecting request (fail-closed)");
          return reply.code(503).send({
            error: "Rate limiting service is temporarily unavailable.",
            code: "RATE_LIMIT_UNAVAILABLE",
          });
        }
        // In dev/test, fall through to in-memory fallback.
      }
    } else if (isProduction && process.env.REDIS_URL) {
      // Redis was configured but not available — fail closed in production.
      return reply.code(503).send({
        error: "Rate limiting service is temporarily unavailable.",
        code: "RATE_LIMIT_UNAVAILABLE",
      });
    }

    const now = Date.now();
    const windowStart = now - windowMs;
    const hits = hitBuckets.get(key) ?? [];
    const recentHits = hits.filter((timestamp) => timestamp > windowStart);
    if (recentHits.length >= maxForRequest) {
      hitBuckets.set(key, recentHits);
      return reply.code(429).send({ error: "Too Many Requests" });
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
      return `admin:${admin?.id ?? request.ip}`;
    },
  });
}
