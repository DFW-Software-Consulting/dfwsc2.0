import { FastifyReply, FastifyRequest } from 'fastify';

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
