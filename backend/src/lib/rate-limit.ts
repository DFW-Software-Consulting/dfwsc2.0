import type { FastifyReply, FastifyRequest } from "fastify";

type RateLimitOptions = {
  max: number;
  windowMs: number;
  keyGenerator?: (request: FastifyRequest) => string;
  maxGenerator?: (request: FastifyRequest) => number;
};

// In-memory limiter — assumes a single API instance. Pin the api service to 1 replica in prod.
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

export function rateLimit(options: RateLimitOptions) {
  const { max, windowMs } = options;
  maxRegisteredWindowMs = Math.max(maxRegisteredWindowMs, windowMs);

  return async function rateLimitGuard(request: FastifyRequest, reply: FastifyReply) {
    const key = `ratelimit:${options.keyGenerator ? options.keyGenerator(request) : request.ip || "unknown"}`;
    const maxForRequest = options.maxGenerator ? options.maxGenerator(request) : max;
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
