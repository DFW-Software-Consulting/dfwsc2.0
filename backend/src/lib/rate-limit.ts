import type { FastifyReply, FastifyRequest } from "fastify";

type RateLimitOptions = {
  max: number;
  windowMs: number;
  keyGenerator?: (request: FastifyRequest) => string;
  maxGenerator?: (request: FastifyRequest) => number;
};

const hitBuckets = new Map<string, number[]>();

// Sweep interval: how often the cleanup runs.
// Bucket max age: must be >= the largest windowMs used by any rate limit (15 min for auth).
// Using a shorter cutoff than the max window would allow rate limit bypass: an attacker
// could exhaust the limit, wait for the sweep to clear their bucket, then bypass the
// still-active window.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // run every 10 minutes
const BUCKET_MAX_AGE_MS = 20 * 60 * 1000; // keep buckets for 20 minutes (> max 15-min window)
setInterval(() => {
  const cutoff = Date.now() - BUCKET_MAX_AGE_MS;
  for (const [key, hits] of hitBuckets) {
    if (hits.every((t) => t < cutoff)) {
      hitBuckets.delete(key);
    }
  }
}, SWEEP_INTERVAL_MS).unref();

export function rateLimit(options: RateLimitOptions) {
  const { max, windowMs } = options;

  return async function rateLimitGuard(request: FastifyRequest, reply: FastifyReply) {
    const key = options.keyGenerator ? options.keyGenerator(request) : request.ip || "unknown";
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
