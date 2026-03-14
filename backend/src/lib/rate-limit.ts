import { FastifyReply, FastifyRequest } from 'fastify';

type RateLimitOptions = {
  max: number;
  windowMs: number;
  keyGenerator?: (request: FastifyRequest) => string;
  maxGenerator?: (request: FastifyRequest) => number;
};

const hitBuckets = new Map<string, number[]>();

// Prune keys with no hits in the last 10 minutes to prevent unbounded growth
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SWEEP_INTERVAL_MS;
  for (const [key, hits] of hitBuckets) {
    if (hits.every((t) => t <= cutoff)) {
      hitBuckets.delete(key);
    }
  }
}, SWEEP_INTERVAL_MS).unref();

export function rateLimit(options: RateLimitOptions) {
  const { max, windowMs } = options;

  return async function rateLimitGuard(request: FastifyRequest, reply: FastifyReply) {
    const key = options.keyGenerator ? options.keyGenerator(request) : request.ip || 'unknown';
    const maxForRequest = options.maxGenerator ? options.maxGenerator(request) : max;
    const now = Date.now();
    const windowStart = now - windowMs;

    const hits = hitBuckets.get(key) ?? [];
    const recentHits = hits.filter((timestamp) => timestamp > windowStart);

    if (recentHits.length === 0) {
      hitBuckets.delete(key);
    }

    if (recentHits.length >= maxForRequest) {
      hitBuckets.set(key, recentHits);
      return reply.code(429).send({ error: 'Too Many Requests' });
    }

    recentHits.push(now);
    hitBuckets.set(key, recentHits);
  };
}
