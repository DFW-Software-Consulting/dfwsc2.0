import { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { db } from '../db/client';
import { clientGroups } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireAdminJwt } from '../lib/auth';

interface GroupBody {
  name: string;
}

interface GroupPatchBody {
  name?: string;
  status?: 'active' | 'inactive';
}

interface GroupParams {
  id: string;
}

const groupRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: GroupBody }>(
    '/groups',
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { name } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).send({ error: 'name is required.' });
      }

      const id = nanoid();
      const now = new Date();
      await db.insert(clientGroups).values({
        id,
        name: name.trim(),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      const [group] = await db.select().from(clientGroups).where(eq(clientGroups.id, id)).limit(1);
      return res.status(201).send({
        id: group.id,
        name: group.name,
        status: group.status,
        createdAt: group.createdAt?.toISOString(),
        updatedAt: group.updatedAt?.toISOString(),
      });
    },
  );

  app.get('/groups', { preHandler: requireAdminJwt }, async (req, res) => {
    const groups = await db.select().from(clientGroups);
    return res.status(200).send(
      groups.map((g) => ({
        id: g.id,
        name: g.name,
        status: g.status,
        createdAt: g.createdAt?.toISOString(),
        updatedAt: g.updatedAt?.toISOString(),
      })),
    );
  });

  app.patch<{ Params: GroupParams; Body: GroupPatchBody }>(
    '/groups/:id',
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { id } = req.params;
      const { name, status } = req.body;

      if (status !== undefined && status !== 'active' && status !== 'inactive') {
        return res.status(400).send({ error: 'Invalid status value. Must be "active" or "inactive".' });
      }
      if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
        return res.status(400).send({ error: 'name must be a non-empty string.' });
      }

      const [existing] = await db.select().from(clientGroups).where(eq(clientGroups.id, id)).limit(1);
      if (!existing) {
        return res.status(404).send({ error: 'Group not found.' });
      }

      const setValues: { updatedAt: Date; name?: string; status?: 'active' | 'inactive' } = {
        updatedAt: new Date(),
      };
      if (name !== undefined) setValues.name = name.trim();
      if (status !== undefined) setValues.status = status;

      await db.update(clientGroups).set(setValues).where(eq(clientGroups.id, id));

      const [updated] = await db.select().from(clientGroups).where(eq(clientGroups.id, id)).limit(1);
      return res.status(200).send({
        id: updated.id,
        name: updated.name,
        status: updated.status,
        createdAt: updated.createdAt?.toISOString(),
        updatedAt: updated.updatedAt?.toISOString(),
      });
    },
  );
};

export default groupRoutes;
