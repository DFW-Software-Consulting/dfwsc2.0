import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client';
import { clients } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireAdminJwt } from '../lib/auth';

interface ClientPatchBody {
  status: 'active' | 'inactive';
}

interface ClientParams {
  id: string;
}

const clientRoutes: FastifyPluginAsync = async (app) => {
  // GET /clients - List all clients (admin only) - NOTE: Will be prefixed with /api/v1 by app.ts
  app.get('/clients', { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      // Query all clients from the database
      const clientList = await db
        .select({
          id: clients.id,
          name: clients.name,
          email: clients.email,
          stripeAccountId: clients.stripeAccountId,
          status: clients.status,
          createdAt: clients.createdAt,
        })
        .from(clients);

      // Format response with proper date serialization
      return res.status(200).send(
        clientList.map(client => ({
          ...client,
          createdAt: client.createdAt?.toISOString(),
        }))
      );
    } catch (error) {
      req.log.error(error, 'Error fetching client list');
      return res.status(500).send({ error: 'Internal server error' });
    }
  });

  // PATCH /clients/:id - Update client status (admin only) - NOTE: Will be prefixed with /api/v1 by app.ts
  app.patch<{
    Params: ClientParams;
    Body: ClientPatchBody;
  }>('/clients/:id', { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      // Validate status value
      if (status !== 'active' && status !== 'inactive') {
        return res.status(400).send({
          error: 'Invalid status value. Must be "active" or "inactive".',
        });
      }

      // Find the client by ID
      const existingClient = await db
        .select()
        .from(clients)
        .where(eq(clients.id, id))
        .limit(1);

      if (existingClient.length === 0) {
        return res.status(404).send({ error: 'Client not found.' });
      }

      // Update the client status
      const updatedClients = await db
        .update(clients)
        .set({ status, updatedAt: new Date() })
        .where(eq(clients.id, id))
        .returning();

      if (updatedClients.length === 0) {
        return res.status(500).send({ error: 'Failed to update client status.' });
      }

      // Return the updated client
      const updatedClient = updatedClients[0];
      return res.status(200).send({
        id: updatedClient.id,
        name: updatedClient.name,
        email: updatedClient.email,
        stripeAccountId: updatedClient.stripeAccountId,
        status: updatedClient.status,
        createdAt: updatedClient.createdAt?.toISOString(),
        updatedAt: updatedClient.updatedAt?.toISOString(),
      });
    } catch (error) {
      req.log.error(error, 'Error updating client status');
      return res.status(500).send({ error: 'Internal server error' });
    }
  });
};

export default clientRoutes;
