import { FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export type Role = 'admin' | 'client';

export function requireRole(allowedRoles: Role[]) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply) {
    const roleHeader = request.headers['x-api-role'];
    const role = Array.isArray(roleHeader) ? roleHeader[0] : roleHeader;

    if (typeof role !== 'string' || !allowedRoles.includes(role as Role)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  };
}

/**
 * Verifies a plaintext password against a bcrypt hash
 * @param plaintext - The plain password to verify
 * @param hashed - The bcrypt hash to compare against
 * @returns Promise resolving to true if passwords match, false otherwise
 */
export async function verifyPassword(plaintext: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hashed);
}

/**
 * Signs a JWT token with the given payload
 * @param payload - The payload to include in the token (must include role)
 * @returns Signed JWT token string
 */
export function signJwt(payload: { role: string }): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }

  const expiresIn = process.env.JWT_EXPIRY || '1h';
  return jwt.sign(payload, secret, { expiresIn });
}

/**
 * Middleware to require and verify JWT authentication for admin routes
 * Expects Authorization header in format: "Bearer <token>"
 * Validates token signature, expiry, and admin role claim
 */
export async function requireAdminJwt(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  // Check for Authorization header
  if (!authHeader) {
    return reply.code(401).send({ error: 'Authorization header required' });
  }

  // Validate Bearer token format
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return reply.code(401).send({ error: 'Invalid authorization header format. Expected: Bearer <token>' });
  }

  const token = parts[1];

  // Verify JWT
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }

    const decoded = jwt.verify(token, secret) as jwt.JwtPayload & { role: string };

    // Verify role claim
    if (decoded.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden: Admin role required' });
    }

    // Optionally attach decoded payload to request for use in route handlers
    // (request as any).user = decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return reply.code(401).send({ error: 'Token expired' });
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return reply.code(401).send({ error: 'Invalid token' });
    }
    // Unknown error
    return reply.code(401).send({ error: 'Authentication failed' });
  }
}
