import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';

// DB is not needed for unit tests but auth.ts imports it at the module level
vi.mock('../../db/client', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
}));

import { signJwt, requireAdminJwt } from '../../lib/auth';

const TEST_SECRET = 'test_jwt_secret_minimum_32_characters_long_random_string';

function makeMockReply() {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

function makeRequest(authHeader?: string) {
  return {
    headers: {
      authorization: authHeader,
    },
  };
}

describe('signJwt', () => {
  const originalSecret = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  it('throws when JWT_SECRET is not set', () => {
    delete process.env.JWT_SECRET;
    expect(() => signJwt({ role: 'admin' })).toThrow('JWT_SECRET is not configured');
  });

  it('returns a signed token when JWT_SECRET is set', () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const token = signJwt({ role: 'admin' });
    const decoded = jwt.verify(token, TEST_SECRET) as jwt.JwtPayload;
    expect(decoded.role).toBe('admin');
  });
});

describe('requireAdminJwt', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });

  it('returns 401 when Authorization header is missing', async () => {
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest() as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Authorization header required' });
  });

  it('returns 401 when header format is not "Bearer <token>"', async () => {
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest('Token abc123') as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Invalid authorization header format. Expected: Bearer <token>',
    });
  });

  it('returns 401 when header has only one part (no space)', async () => {
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest('BearerNoSpace') as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('returns 403 when token role is not admin', async () => {
    const token = jwt.sign({ role: 'viewer' }, TEST_SECRET, { expiresIn: '1h' });
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${token}`) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Forbidden: Admin role required' });
  });

  it('returns 401 with "Token expired" for an expired token', async () => {
    // Sign a token that expired 10 seconds ago
    const token = jwt.sign({ role: 'admin' }, TEST_SECRET, { expiresIn: -10 });
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${token}`) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Token expired' });
  });

  it('returns 401 with "Invalid token" for a tampered/invalid token', async () => {
    // Build a valid token then corrupt the signature
    const validToken = jwt.sign({ role: 'admin' }, TEST_SECRET, { expiresIn: '1h' });
    const tamperedToken = validToken.slice(0, -5) + 'XXXXX';
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${tamperedToken}`) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Invalid token' });
  });

  it('returns 401 with "Authentication failed" when JWT_SECRET is missing inside try', async () => {
    // The guard throws a plain Error (not a JWT error) when JWT_SECRET is missing
    // inside the try block. Delete it after the function reads headers but before
    // it calls jwt.verify. We achieve this by deleting it right before the call.
    delete process.env.JWT_SECRET;

    const token = jwt.sign({ role: 'admin' }, TEST_SECRET, { expiresIn: '1h' });
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${token}`) as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Authentication failed' });
  });

  it('does not call reply.code when the token is valid with admin role', async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const token = jwt.sign({ role: 'admin' }, TEST_SECRET, { expiresIn: '1h' });
    const reply = makeMockReply();
    await requireAdminJwt(makeRequest(`Bearer ${token}`) as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});
