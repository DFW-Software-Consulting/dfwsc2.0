
import { FastifyInstance } from 'fastify';

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (request, reply) => {
    reply.code(200).send({ status: 'ok' });
  });
}
