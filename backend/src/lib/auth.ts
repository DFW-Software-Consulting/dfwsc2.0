import { FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema';

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

export async function requireApiKey(request: FastifyRequest, reply: FastifyReply) {
  const apiKeyHeader = request.headers['x-api-key'];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;

  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return reply.code(401).send({ error: 'API key is required.' });
  }

  try {
    // First, try to find a client with a matching API key hash
    const allClientsResult = await db.select().from(clients);
    // Ensure we have an array to iterate over
    const allClients = Array.isArray(allClientsResult) ? allClientsResult : [];

    for (const client of allClients) {
      if (client.apiKeyHash) {
        const isValid = await verifyPassword(apiKey, client.apiKeyHash);
        if (isValid && client.status !== 'inactive') {
          (request as FastifyRequest & { client?: typeof clients.$inferSelect }).client = client;
          return; // Found valid client, exit early
        }
      }
    }

    // For backward compatibility during migration, also check plaintext keys
    const [plaintextClient] = await db
      .select()
      .from(clients)
      .where(and(eq(clients.apiKey, apiKey), eq(clients.status, 'active')))
      .limit(1);

    if (plaintextClient) {
      (request as FastifyRequest & { client?: typeof clients.$inferSelect }).client = plaintextClient;
      return; // Found valid client with plaintext key
    }

    // To prevent user enumeration, return the same error regardless of whether the key exists
    return reply.code(401).send({ error: 'Invalid API key.' });
  } catch (error) {
    console.error('Error in requireApiKey:', error);
    return reply.code(500).send({ error: 'Internal server error during API key validation.' });
  }
}

/**
 * Hashes an API key using bcrypt
 * @param apiKey - The plaintext API key to hash
 * @returns Promise resolving to the bcrypt hash
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const saltRounds = 10;
  return bcrypt.hash(apiKey, saltRounds);
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
  return jwt.sign(payload, secret, { expiresIn } as jwt.SignOptions);
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
