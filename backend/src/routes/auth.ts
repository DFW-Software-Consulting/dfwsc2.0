import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { signJwt } from '../lib/auth';
import { rateLimit } from '../lib/rate-limit';

interface LoginRequest {
  username: string;
  password: string;
}

/**
 * Validates that ADMIN_PASSWORD is bcrypt-hashed in production mode.
 * Throws an error if NODE_ENV=production and password is plaintext.
 * Returns true if validation passes, false if warning-only (dev mode).
 */
export function validateAdminPasswordConfig(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    // No password set - this will be caught during login attempt
    return true;
  }

  const isBcryptHash = /^\$2[aby]\$/.test(adminPassword);

  if (nodeEnv === 'production' && !isBcryptHash) {
    throw new Error(
      'SECURITY ERROR: ADMIN_PASSWORD must be a bcrypt hash in production mode. ' +
      'Plaintext passwords are not allowed. Generate a hash with: ' +
      'node -e "console.log(require(\'bcryptjs\').hashSync(\'your-password\', 10))"'
    );
  }

  return isBcryptHash;
}

// Runtime flag to track if setup has been used (resets on container restart)
let setupUsed = false;

export default async function authRoutes(fastify: FastifyInstance) {
  // Validate admin password configuration on route registration
  const isHashed = validateAdminPasswordConfig();
  if (!isHashed && process.env.ADMIN_PASSWORD) {
    fastify.log.warn(
      'DEPRECATION WARNING: ADMIN_PASSWORD is stored in plaintext. ' +
      'This is insecure and will cause startup failure in production mode. ' +
      'Please use a bcrypt hash instead.'
    );
  }

  // GET /auth/setup/status - Check if admin setup is allowed
  fastify.get('/auth/setup/status', async (_request, reply) => {
    const allowAdminSetup = process.env.ALLOW_ADMIN_SETUP === 'true';
    const adminConfigured = !!process.env.ADMIN_PASSWORD;

    // Setup is only allowed if:
    // 1. ALLOW_ADMIN_SETUP=true
    // 2. No ADMIN_PASSWORD is set
    // 3. Setup hasn't been used this session
    const setupAllowed = allowAdminSetup && !adminConfigured && !setupUsed;

    return reply.code(200).send({
      setupAllowed,
      adminConfigured,
    });
  });

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
          // SECURITY WARNING: Log deprecation notice for plaintext passwords
          fastify.log.warn(
            'DEPRECATION WARNING: ADMIN_PASSWORD is stored in plaintext. ' +
            'This is insecure and will be removed in a future version. ' +
            'Please use a bcrypt hash instead. Generate one with: ' +
            'node -e "console.log(require(\'bcryptjs\').hashSync(\'your-password\', 10))"'
          );
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
