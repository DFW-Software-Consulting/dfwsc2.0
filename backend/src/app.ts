import fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyRawBody from 'fastify-raw-body';

import connectRoutes from './routes/connect';
import paymentsRoutes from './routes/payments';
import webhooksRoute from './routes/webhooks';
import configRoutes from './routes/config';
import healthRoutes from './routes/health';
import authRoutes from './routes/auth';
import clientRoutes from './routes/clients';
import { sendMail } from './lib/mailer';
import { validateEnv, logMaskedEnvSummary } from './lib/env';

export async function buildServer() {
  const server = fastify({
    logger: true,
    ajv: {
      customOptions: {
        allErrors: true,
      },
    },
    schemaErrorFormatter: (errors, _dataVar) => {
      const required = errors.filter((e) => e.keyword === 'required');
      if (required.length > 0) {
        const missing = Array.from(
          new Set(required.map((e) => (e.params as { missingProperty?: string }).missingProperty).filter(Boolean)),
        );
        if (missing.length > 1) {
          return new Error(`${missing.join(', ')} are required.`);
        }
        const [firstMissing] = missing;
        return new Error(`${firstMissing} is required.`);
      }
      const messages = errors.map((e) => e.message).filter(Boolean);
      return new Error(messages.join(', '));
    },
  });
  const env = validateEnv();
  logMaskedEnvSummary(server, env);

  const frontendOrigin = env.FRONTEND_ORIGIN ?? '';

  const allowedOrigins = frontendOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  server.register(fastifyCors, {
    origin: allowedOrigins.length === 0 ? true : allowedOrigins,
    credentials: true,
  });

  server.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  server.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? (error.validation ? 400 : 500);

    if (error.validation) {
      reply.status(statusCode).send({ error: error.message });
      return;
    }

    request.log.error(error, error.message);
    reply.status(statusCode).send({ error: error.message ?? 'Internal Server Error' });
  });

  /**
   * 🚀 Optional Swagger Setup
   * ------------------------------------------------------------
   * This section conditionally enables Fastify Swagger + Swagger UI.
   *
   * By default, Swagger is *enabled* for local/dev environments.
   * For production, you can disable it by setting:
   *
   *    ENABLE_SWAGGER=false
   *
   * inside your `.env.prod` file.
   *
   * When disabled, Swagger modules aren't loaded at all — this keeps
   * the production image lighter and avoids module-not-found errors
   * (since dev-only dependencies like @fastify/swagger aren't installed
   * in production builds).
   *
   * Example ENV config:
   * ------------------------------------------------------------
   * ENABLE_SWAGGER=true   # for local dev
   * ENABLE_SWAGGER=false  # for prod builds
   * ------------------------------------------------------------
   */

  if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_SWAGGER !== 'false') {
    const { default: fastifySwagger } = await import('@fastify/swagger');
    const { default: fastifySwaggerUi } = await import('@fastify/swagger-ui');
    await server.register(fastifySwagger, {
      openapi: { info: { title: 'Stripe Portal API', version: '1.0.0' } },
    });
    await server.register(fastifySwaggerUi, { routePrefix: '/docs' });
    server.log.info('✅ Swagger UI available at /docs');
  } else {
    server.log.info('🚫 Swagger disabled for production');
  }

  server.register(configRoutes);
  server.register(healthRoutes, { prefix: '/api/v1' });
  server.register(authRoutes, { prefix: '/api/v1' });
  server.register(connectRoutes, { prefix: '/api/v1' });
  server.register(paymentsRoutes, { prefix: '/api/v1' });
  server.register(webhooksRoute, { prefix: '/api/v1' });
  server.register(clientRoutes, { prefix: '/api/v1' });

  server.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not Found' });
  });

  return server;
}