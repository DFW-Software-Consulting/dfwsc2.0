import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/client";
import { clientGroups, clients, onboardingTokens } from "../../db/schema";
import { createClientWithOnboardingToken } from "../../lib/client-factory";

const workspace = "dfwsc_services";
const cleanupIds: { clients: string[]; groups: string[] } = { clients: [], groups: [] };

let hashCallCount = 0;

vi.mock("../../lib/auth", () => ({
  hashApiKey: vi.fn().mockImplementation(() => {
    hashCallCount++;
    return Promise.resolve(`hashed-api-key-${hashCallCount}-${Date.now()}`);
  }),
  sha256Lookup: vi.fn().mockImplementation((key: string) => {
    hashCallCount++;
    return `sha256-lookup-${hashCallCount}-${Date.now()}-${key.slice(0, 8)}`;
  }),
}));

beforeAll(async () => {
  vi.clearAllMocks();
});

beforeEach(() => {
  hashCallCount = 0;
});

afterAll(async () => {
  for (const id of cleanupIds.clients) {
    try {
      await db.delete(onboardingTokens).where(eq(onboardingTokens.clientId, id));
      await db.delete(clients).where(eq(clients.id, id));
    } catch {}
  }
  for (const id of cleanupIds.groups) {
    try {
      await db.delete(clientGroups).where(eq(clientGroups.id, id));
    } catch {}
  }
});

describe("createClientWithOnboardingToken", () => {
  it("creates client successfully with required fields only", async () => {
    const email = `test-${randomUUID()}@example.com`;
    const result = await createClientWithOnboardingToken({
      name: "Test Client",
      email,
      workspace,
    });

    expect(result.clientId).toBeDefined();
    expect(result.apiKey).toBeDefined();
    expect(result.token).toBeDefined();
    cleanupIds.clients.push(result.clientId);
  });

  it("creates client with stripeCustomerId", async () => {
    const email = `test-${randomUUID()}@example.com`;
    const result = await createClientWithOnboardingToken({
      name: "Test Client",
      email,
      workspace,
      stripeCustomerId: "cus_123456",
    });

    expect(result.clientId).toBeDefined();
    const [client] = await db.select().from(clients).where(eq(clients.id, result.clientId));
    expect(client?.stripeCustomerId).toBe("cus_123456");
    cleanupIds.clients.push(result.clientId);
  });

  it("creates client with groupId", async () => {
    const groupId = randomUUID();
    await db.insert(clientGroups).values({
      id: groupId,
      name: "Test Group",
      workspace,
    });
    cleanupIds.groups.push(groupId);

    const email = `test-${randomUUID()}@example.com`;
    const result = await createClientWithOnboardingToken({
      name: "Test Client",
      email,
      workspace,
      groupId,
    });

    expect(result.clientId).toBeDefined();
    const [client] = await db.select().from(clients).where(eq(clients.id, result.clientId));
    expect(client?.groupId).toBe(groupId);
    cleanupIds.clients.push(result.clientId);
  });

  it("throws error when name is empty string", async () => {
    await expect(
      createClientWithOnboardingToken({
        name: "",
        email: "test@example.com",
        workspace,
      })
    ).rejects.toMatchObject({
      message: "Name is required and must be a non-empty string",
      statusCode: 400,
    });
  });

  it("throws error when name is whitespace only", async () => {
    await expect(
      createClientWithOnboardingToken({
        name: "   ",
        email: "test@example.com",
        workspace,
      })
    ).rejects.toMatchObject({
      message: "Name is required and must be a non-empty string",
      statusCode: 400,
    });
  });

  it("throws error when name is undefined", async () => {
    await expect(
      createClientWithOnboardingToken({
        name: undefined as unknown as string,
        email: "test@example.com",
        workspace,
      })
    ).rejects.toMatchObject({
      message: "Name is required and must be a non-empty string",
      statusCode: 400,
    });
  });

  it("throws error when name is not a string", async () => {
    await expect(
      createClientWithOnboardingToken({
        name: 123 as unknown as string,
        email: "test@example.com",
        workspace,
      })
    ).rejects.toMatchObject({
      message: "Name is required and must be a non-empty string",
      statusCode: 400,
    });
  });

  it("throws error when email is invalid", async () => {
    await expect(
      createClientWithOnboardingToken({
        name: "Test Client",
        email: "invalid-email",
        workspace,
      })
    ).rejects.toMatchObject({
      message: "Valid email is required",
      statusCode: 400,
    });
  });

  it("throws error when email is empty string", async () => {
    await expect(
      createClientWithOnboardingToken({
        name: "Test Client",
        email: "",
        workspace,
      })
    ).rejects.toMatchObject({
      message: "Valid email is required",
      statusCode: 400,
    });
  });

  it("throws error when email is undefined", async () => {
    await expect(
      createClientWithOnboardingToken({
        name: "Test Client",
        email: undefined as unknown as string,
        workspace,
      })
    ).rejects.toMatchObject({
      message: "Valid email is required",
      statusCode: 400,
    });
  });

  it("throws error when groupId does not exist", async () => {
    await expect(
      createClientWithOnboardingToken({
        name: "Test Client",
        email: "test@example.com",
        workspace,
        groupId: randomUUID(),
      })
    ).rejects.toMatchObject({
      message: "Invalid groupId.",
      statusCode: 400,
    });
  });

  it("throws error when groupId workspace does not match", async () => {
    const groupId = randomUUID();
    await db.insert(clientGroups).values({
      id: groupId,
      name: "Test Group",
      workspace: "client_portal",
    });
    cleanupIds.groups.push(groupId);

    await expect(
      createClientWithOnboardingToken({
        name: "Test Client",
        email: "test@example.com",
        workspace,
        groupId,
      })
    ).rejects.toMatchObject({
      message: "groupId workspace does not match client workspace.",
      statusCode: 400,
    });
  });
});
