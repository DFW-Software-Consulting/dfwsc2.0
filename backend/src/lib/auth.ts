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
