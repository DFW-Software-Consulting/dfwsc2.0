import { FastifyInstance, FastifyRequest } from 'fastify';

function resolveApiBaseUrl(request: FastifyRequest): string {
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL.replace(/\/$/, '');
  }

  const host = request.headers['x-forwarded-host'] ?? request.headers.host;
  const protocol = (request.headers['x-forwarded-proto'] as string) ?? request.protocol;

  return `${protocol}://${host}`.replace(/\/$/, '');
}

export default async function configRoutes(fastify: FastifyInstance) {
  fastify.get('/app-config.js', (request, reply) => {
    const apiUrl = resolveApiBaseUrl(request);
    const script = `window.API_URL = '${apiUrl}';`;

    reply
      .header('Content-Type', 'application/javascript')
      .send(script);
  });
}
