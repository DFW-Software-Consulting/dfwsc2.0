import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../app';
import { db } from '../db/client';
import { clients } from '../db/schema';
import { eq } from 'drizzle-orm';
import * as jwt from 'jsonwebtoken';
import supertest from 'supertest';

describe('Client Status Update API', () => {
  let app: any;
  const mockClientId = 'test-client-id-123';
  const mockAdminToken = jwt.sign(
    { username: 'admin', role: 'admin' },
    process.env.JWT_SECRET || 'your_jwt_secret_minimum_32_characters_long_random_string',
    { expiresIn: '1h' }
  );
  const mockNonAdminToken = jwt.sign(
    { username: 'user', role: 'user' },
    process.env.JWT_SECRET || 'your_jwt_secret_minimum_32_characters_long_random_string',
    { expiresIn: '1h' }
  );

  beforeEach(async () => {
    app = await buildServer();
    // Mock a client in the database for testing
    await db.insert(clients).values({
      id: mockClientId,
      name: 'Test Client',
      email: 'test@example.com',
      stripeAccountId: 'acct_123456789',
      status: 'active', // Default status
    });
  });

  afterEach(async () => {
    // Clean up test data
    await db.delete(clients).where(eq(clients.id, mockClientId));
  });

  describe('PATCH /api/v1/clients/:id', () => {
    it('should successfully update client status to inactive when called by admin', async () => {
      const response = await supertest(app.server)
        .patch(`/api/v1/clients/${mockClientId}`)
        .set('Authorization', `Bearer ${mockAdminToken}`)
        .send({ status: 'inactive' })
        .expect(200);

      expect(response.body).toHaveProperty('id', mockClientId);
      expect(response.body).toHaveProperty('status', 'inactive');

      // Verify the database was updated
      const updatedClient = await db.select().from(clients).where(eq(clients.id, mockClientId));
      expect(updatedClient[0].status).toBe('inactive');
    });

    it('should successfully update client status to active when called by admin', async () => {
      // First, set the client to inactive
      await db.update(clients).set({ status: 'inactive' }).where(eq(clients.id, mockClientId));

      const response = await supertest(app.server)
        .patch(`/api/v1/clients/${mockClientId}`)
        .set('Authorization', `Bearer ${mockAdminToken}`)
        .send({ status: 'active' })
        .expect(200);

      expect(response.body).toHaveProperty('id', mockClientId);
      expect(response.body).toHaveProperty('status', 'active');

      // Verify the database was updated
      const updatedClient = await db.select().from(clients).where(eq(clients.id, mockClientId));
      expect(updatedClient[0].status).toBe('active');
    });

    it('should return 403 when called by non-admin user', async () => {
      const response = await supertest(app.server)
        .patch(`/api/v1/clients/${mockClientId}`)
        .set('Authorization', `Bearer ${mockNonAdminToken}`)
        .send({ status: 'inactive' })
        .expect(403);

      expect(response.body).toHaveProperty('error');
    });

    it('should return 401 when called without authorization token', async () => {
      const response = await supertest(app.server)
        .patch(`/api/v1/clients/${mockClientId}`)
        .send({ status: 'inactive' })
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });

    it('should return 400 when called with invalid status value', async () => {
      const response = await supertest(app.server)
        .patch(`/api/v1/clients/${mockClientId}`)
        .set('Authorization', `Bearer ${mockAdminToken}`)
        .send({ status: 'invalid_status' as any })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Invalid status value');
    });

    it('should return 404 when client ID does not exist', async () => {
      const response = await supertest(app.server)
        .patch('/api/v1/clients/nonexistent-id')
        .set('Authorization', `Bearer ${mockAdminToken}`)
        .send({ status: 'inactive' })
        .expect(404);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('Client not found.');
    });
  });
});