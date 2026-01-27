import { FastifyInstance, FastifyRequest } from 'fastify';

function resolveApiBaseUrl(): string {
  if (!process.env.API_BASE_URL) {
    throw new Error('API_BASE_URL environment variable is required but not set');
  }

  return process.env.API_BASE_URL.replace(/\/$/, '');
}

export default async function configRoutes(fastify: FastifyInstance) {
  fastify.get('/app-config.js', (request, reply) => {
    try {
      const apiUrl = resolveApiBaseUrl();
      // Use JSON.stringify for safe JavaScript string embedding to prevent XSS
      const script = `window.API_URL = ${JSON.stringify(apiUrl)};`;

      reply
        .header('Content-Type', 'application/javascript')
        .send(script);
    } catch (error) {
      request.log.error(error, 'Failed to resolve API base URL');
      reply.status(500).send({ error: 'Internal Server Error: API_BASE_URL not configured' });
    }
  });
}
