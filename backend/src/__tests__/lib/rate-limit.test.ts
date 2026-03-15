import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 600_000 ms

beforeAll(() => {
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
});

// Fresh module import per test so hitBuckets starts empty
async function getRateLimit() {
  vi.resetModules();
  const mod = await import('../../lib/rate-limit');
  return mod.rateLimit;
}

function makeMocks(ip = '127.0.0.1') {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  const request = {
    ip,
    headers: {},
  };
  return { request, reply };
}

describe('rateLimit', () => {
  beforeEach(() => {
    vi.resetModules();
    // Keep fake timers active but don't advance them between tests
  });

  it('allows requests up to max without blocking', async () => {
    const rateLimit = await getRateLimit();
    const guard = rateLimit({ max: 3, windowMs: 60_000 });
    const { request, reply } = makeMocks();

    for (let i = 0; i < 3; i++) {
      await guard(request as any, reply as any);
    }

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('returns 429 when max is exceeded', async () => {
    const rateLimit = await getRateLimit();
    const guard = rateLimit({ max: 2, windowMs: 60_000 });
    const { request, reply } = makeMocks();

    // Use up the budget
    await guard(request as any, reply as any);
    await guard(request as any, reply as any);

    // This one should be blocked
    await guard(request as any, reply as any);

    expect(reply.code).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Too Many Requests' });
  });

  it('uses a custom keyGenerator when provided', async () => {
    const rateLimit = await getRateLimit();
    const keyGenerator = vi.fn().mockReturnValue('custom-key');
    const guard = rateLimit({ max: 1, windowMs: 60_000, keyGenerator });
    const { request, reply } = makeMocks('10.0.0.1');

    await guard(request as any, reply as any);
    await guard(request as any, reply as any); // should block

    expect(keyGenerator).toHaveBeenCalledWith(request);
    expect(reply.code).toHaveBeenCalledWith(429);
  });

  it('uses a custom maxGenerator when provided', async () => {
    const rateLimit = await getRateLimit();
    // maxGenerator returns a higher limit than `max`
    const maxGenerator = vi.fn().mockReturnValue(5);
    const guard = rateLimit({ max: 1, windowMs: 60_000, maxGenerator });
    const { request, reply } = makeMocks();

    // Should allow 5 requests (from maxGenerator), not just 1
    for (let i = 0; i < 5; i++) {
      await guard(request as any, reply as any);
    }
    expect(reply.code).not.toHaveBeenCalled();

    // 6th should be blocked
    await guard(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(429);
  });

  it('falls back to "unknown" when request.ip is falsy', async () => {
    const rateLimit = await getRateLimit();
    const guard = rateLimit({ max: 1, windowMs: 60_000 });
    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    const request = { ip: '', headers: {} };

    await guard(request as any, reply as any); // ok
    await guard(request as any, reply as any); // blocked — same "unknown" bucket

    expect(reply.code).toHaveBeenCalledWith(429);
  });

  it('sweep interval cleans stale entries so keys can make requests again', async () => {
    const rateLimit = await getRateLimit();

    // Window is 1 ms so hits expire almost immediately (relative to fake time)
    const guard = rateLimit({ max: 1, windowMs: 1 });
    const { request, reply } = makeMocks('sweep-test-ip');

    // Use up the budget at fake time T=0
    await guard(request as any, reply as any);

    // Immediately try again — should be blocked
    await guard(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(429);
    vi.clearAllMocks();

    // Advance time past window AND past the sweep interval so stale bucket is deleted
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS + 1);

    // After the sweep the bucket for this key should be gone; the guard
    // treats a missing bucket as zero hits, so the request goes through.
    await guard(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});
