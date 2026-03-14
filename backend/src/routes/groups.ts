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
  processingFeePercent?: number | null;
  processingFeeCents?: number | null;
  paymentSuccessUrl?: string | null;
  paymentCancelUrl?: string | null;
}

interface GroupParams {
  id: string;
}

function isValidHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function formatGroupResponse(g: typeof clientGroups.$inferSelect) {
  return {
    id: g.id,
    name: g.name,
    status: g.status,
    processingFeePercent: g.processingFeePercent,
    processingFeeCents: g.processingFeeCents,
    paymentSuccessUrl: g.paymentSuccessUrl,
    paymentCancelUrl: g.paymentCancelUrl,
    createdAt: g.createdAt?.toISOString(),
    updatedAt: g.updatedAt?.toISOString(),
  };
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
      return res.status(201).send(formatGroupResponse(group));
    },
  );

  app.get('/groups', { preHandler: requireAdminJwt }, async (req, res) => {
    const groups = await db.select().from(clientGroups);
    return res.status(200).send(groups.map(formatGroupResponse));
  });

  app.patch<{ Params: GroupParams; Body: GroupPatchBody }>(
    '/groups/:id',
    { preHandler: requireAdminJwt },
    async (req, res) => {
      const { id } = req.params;
      const { name, status, processingFeePercent, processingFeeCents, paymentSuccessUrl, paymentCancelUrl } = req.body;

      if (status !== undefined && status !== 'active' && status !== 'inactive') {
        return res.status(400).send({ error: 'Invalid status value. Must be "active" or "inactive".' });
      }
      if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
        return res.status(400).send({ error: 'name must be a non-empty string.' });
      }

      if (processingFeePercent != null && processingFeeCents != null) {
        return res.status(400).send({ error: 'Set one fee type, not both.' });
      }
      if (processingFeePercent != null && (processingFeePercent <= 0 || processingFeePercent > 100)) {
        return res.status(400).send({ error: 'processingFeePercent must be greater than 0 and at most 100.' });
      }
      if (processingFeeCents != null && (!Number.isInteger(processingFeeCents) || processingFeeCents < 0)) {
        return res.status(400).send({ error: 'processingFeeCents must be a non-negative integer.' });
      }
      if (paymentSuccessUrl != null && !isValidHttpsUrl(paymentSuccessUrl)) {
        return res.status(400).send({ error: 'paymentSuccessUrl must be a valid HTTPS URL.' });
      }
      if (paymentCancelUrl != null && !isValidHttpsUrl(paymentCancelUrl)) {
        return res.status(400).send({ error: 'paymentCancelUrl must be a valid HTTPS URL.' });
      }

      const [existing] = await db.select().from(clientGroups).where(eq(clientGroups.id, id)).limit(1);
      if (!existing) {
        return res.status(404).send({ error: 'Group not found.' });
      }

      const setValues: {
        updatedAt: Date;
        name?: string;
        status?: 'active' | 'inactive';
        processingFeePercent?: string | null;
        processingFeeCents?: number | null;
        paymentSuccessUrl?: string | null;
        paymentCancelUrl?: string | null;
      } = { updatedAt: new Date() };

      if (name !== undefined) setValues.name = name.trim();
      if (status !== undefined) setValues.status = status;
      if ('processingFeePercent' in req.body)
        setValues.processingFeePercent = processingFeePercent != null ? String(processingFeePercent) : null;
      if ('processingFeeCents' in req.body) setValues.processingFeeCents = processingFeeCents;
      if ('paymentSuccessUrl' in req.body) setValues.paymentSuccessUrl = paymentSuccessUrl;
      if ('paymentCancelUrl' in req.body) setValues.paymentCancelUrl = paymentCancelUrl;

      await db.update(clientGroups).set(setValues).where(eq(clientGroups.id, id));

      const [updated] = await db.select().from(clientGroups).where(eq(clientGroups.id, id)).limit(1);
      return res.status(200).send(formatGroupResponse(updated));
    },
  );
};

export default groupRoutes;
