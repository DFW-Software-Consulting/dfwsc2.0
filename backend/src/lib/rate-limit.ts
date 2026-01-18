import { FastifyReply, FastifyRequest } from 'fastify';

type RateLimitOptions = {
  max: number;
  windowMs: number;
  keyGenerator?: (request: FastifyRequest) => string;
  maxGenerator?: (request: FastifyRequest) => number;
};

const hitBuckets = new Map<string, number[]>();

export function rateLimit(options: RateLimitOptions) {
  const { max, windowMs } = options;

  return async function rateLimitGuard(request: FastifyRequest, reply: FastifyReply) {
    const key = options.keyGenerator ? options.keyGenerator(request) : request.ip || 'unknown';
    const maxForRequest = options.maxGenerator ? options.maxGenerator(request) : max;
    const now = Date.now();
    const windowStart = now - windowMs;

    const hits = hitBuckets.get(key) ?? [];
    const recentHits = hits.filter((timestamp) => timestamp > windowStart);

    if (recentHits.length >= maxForRequest) {
      hitBuckets.set(key, recentHits);
      return reply.code(429).send({ error: 'Too Many Requests' });
    }

    recentHits.push(now);
    hitBuckets.set(key, recentHits);
  };
}
