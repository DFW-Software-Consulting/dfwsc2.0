import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { signJwt } from '../lib/auth.js';
import { rateLimit } from '../lib/rate-limit.js';

interface LoginRequest {
  username: string;
  password: string;
}

export default async function authRoutes(fastify: FastifyInstance) {
  // POST /auth/login - Admin login endpoint
  fastify.post(
    '/auth/login',
    {
      preHandler: rateLimit({ max: 5, windowMs: 15 * 60 * 1000 }), // 5 requests per 15 minutes
    },
    async (request, reply) => {
      const { username, password } = request.body as LoginRequest;

      // Validate request body
      if (!username || !password) {
        return reply.code(400).send({ error: 'Username and password are required' });
      }

      // Get admin credentials from environment
      const adminUsername = process.env.ADMIN_USERNAME;
      const adminPassword = process.env.ADMIN_PASSWORD;

      if (!adminUsername || !adminPassword) {
        fastify.log.error('Admin credentials not configured in environment');
        return reply.code(500).send({ error: 'Server configuration error' });
      }

      // Verify credentials
      // Note: For production, ADMIN_PASSWORD should be a bcrypt hash
      // For now, supporting both plaintext and hash comparison
      let isValid = false;

      if (username === adminUsername) {
        // Check if password is already hashed (starts with $2a$, $2b$, or $2y$)
        if (adminPassword.match(/^\$2[aby]\$/)) {
          // Compare against bcrypt hash
          isValid = await bcrypt.compare(password, adminPassword);
        } else {
          // Direct comparison for plaintext (development only)
          isValid = password === adminPassword;
        }
      }

      if (!isValid) {
        // Log failed login attempt
        fastify.log.warn({ username }, 'Failed login attempt');
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      // Generate JWT token
      try {
        const token = signJwt({ role: 'admin' });
        const expiresIn = process.env.JWT_EXPIRY || '1h';

        fastify.log.info({ username }, 'Successful admin login');

        return reply.code(200).send({
          token,
          expiresIn,
        });
      } catch (error) {
        fastify.log.error({ error }, 'Error generating JWT token');
        return reply.code(500).send({ error: 'Authentication error' });
      }
    },
  );
}
