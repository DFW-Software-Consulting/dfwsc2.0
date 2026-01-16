import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../app';
import { db } from '../db/client';
import { clients } from '../db/schema';
import { eq } from 'drizzle-orm';
import * as jwt from 'jsonwebtoken';
import supertest from 'supertest';

describe('Client Management API', () => {
  let app: any;
  let mockAdminToken: string;
  let mockNonAdminToken: string;
  const mockClientId = 'test-client-id-123';
  const mockSecondClientId = 'test-client-id-456';

  beforeEach(async () => {
    app = await buildServer();
    await app.ready();
    const jwtSecret =
      process.env.JWT_SECRET || 'your_jwt_secret_minimum_32_characters_long_random_string';
    mockAdminToken = jwt.sign({ username: 'admin', role: 'admin' }, jwtSecret, {
      expiresIn: '1h',
    });
    mockNonAdminToken = jwt.sign({ username: 'user', role: 'user' }, jwtSecret, {
      expiresIn: '1h',
    });
    // Mock clients in the database for testing
    await db.insert(clients).values([
      {
        id: mockClientId,
        name: 'Test Client',
        email: 'test@example.com',
        stripeAccountId: 'acct_123456789',
        status: 'active', // Default status
      },
      {
        id: mockSecondClientId,
        name: 'Second Test Client',
        email: 'second@example.com',
        stripeAccountId: 'acct_987654321',
        status: 'inactive',
      }
    ]);
  });

  afterEach(async () => {
    // Clean up test data
    await db.delete(clients).where(eq(clients.id, mockClientId));
    await db.delete(clients).where(eq(clients.id, mockSecondClientId));
    await app.close();
  });

  describe('GET /api/v1/clients', () => {
    it('should successfully list all clients when called by admin', async () => {
      const response = await supertest(app.server)
        .get('/api/v1/clients')
        .set('Authorization', `Bearer ${mockAdminToken}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(2); // At least our 2 test clients

      // Find our test clients in the response
      const testClient = response.body.find((client: any) => client.id === mockClientId);
      const secondClient = response.body.find((client: any) => client.id === mockSecondClientId);

      expect(testClient).toBeDefined();
      expect(secondClient).toBeDefined();

      // Verify required fields are present for test client
      expect(testClient).toHaveProperty('id', mockClientId);
      expect(testClient).toHaveProperty('name', 'Test Client');
      expect(testClient).toHaveProperty('email', 'test@example.com');
      expect(testClient).toHaveProperty('stripeAccountId', 'acct_123456789');
      expect(testClient).toHaveProperty('status', 'active');
      expect(testClient).toHaveProperty('createdAt');
      // Verify createdAt is a valid ISO string
      expect(() => new Date(testClient.createdAt)).not.toThrow();

      // Verify required fields are present for second client
      expect(secondClient).toHaveProperty('id', mockSecondClientId);
      expect(secondClient).toHaveProperty('name', 'Second Test Client');
      expect(secondClient).toHaveProperty('email', 'second@example.com');
      expect(secondClient).toHaveProperty('stripeAccountId', 'acct_987654321');
      expect(secondClient).toHaveProperty('status', 'inactive');
      expect(secondClient).toHaveProperty('createdAt');
      // Verify createdAt is a valid ISO string
      expect(() => new Date(secondClient.createdAt)).not.toThrow();
    });

    it('should return empty array when no clients exist', async () => {
      // Clean up all clients first
      await db.delete(clients);

      const response = await supertest(app.server)
        .get('/api/v1/clients')
        .set('Authorization', `Bearer ${mockAdminToken}`)
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('should return 403 when called by non-admin user', async () => {
      const response = await supertest(app.server)
        .get('/api/v1/clients')
        .set('Authorization', `Bearer ${mockNonAdminToken}`)
        .expect(403);

      expect(response.body).toHaveProperty('error');
    });

    it('should return 401 when called without authorization token', async () => {
      const response = await supertest(app.server)
        .get('/api/v1/clients')
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });
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
