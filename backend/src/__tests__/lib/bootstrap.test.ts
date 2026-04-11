import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/client";
import { admins } from "../../db/schema";
import { bootstrapAdminIfNeeded } from "../../lib/bootstrap";

// Mock DB
vi.mock("../../db/client", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
  },
}));

describe("Bootstrap Lib", () => {
  let mockServer: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };
    // Reset env vars
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ALLOW_ADMIN_SETUP;
  });

  it("should skip if no credentials provided and admins exist", async () => {
    (db.select as any).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => [{ id: "1", username: "existing" }]),
        })),
      })),
    });

    process.env.ADMIN_USERNAME = "testadmin";
    process.env.ADMIN_PASSWORD = "testpassword";

    await bootstrapAdminIfNeeded(mockServer);

    expect(mockServer.log.info).toHaveBeenCalledWith(
      { username: "testadmin" },
      "Bootstrap: admin account already exists."
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("should bootstrap admin if credentials provided and no admin exists", async () => {
    process.env.ADMIN_USERNAME = "newadmin";
    process.env.ADMIN_PASSWORD = "newpassword";

    // Mock empty DB for the first check
    (db.select as any).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => []),
        })),
      })),
    });

    await bootstrapAdminIfNeeded(mockServer);

    expect(db.insert).toHaveBeenCalled();
    expect(mockServer.log.info).toHaveBeenCalledWith(
      { username: "newadmin" },
      "Admin account bootstrapped successfully."
    );
  });

  it("should bootstrap in unconfirmed mode if ALLOW_ADMIN_SETUP is true", async () => {
    process.env.ADMIN_USERNAME = "setupadmin";
    process.env.ADMIN_PASSWORD = "setuppassword";
    process.env.ALLOW_ADMIN_SETUP = "true";

    (db.select as any).mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => []),
        })),
      })),
    });

    await bootstrapAdminIfNeeded(mockServer);

    expect(db.insert).toHaveBeenCalled();
    expect(mockServer.log.info).toHaveBeenCalledWith(
      { username: "setupadmin" },
      "Admin account bootstrapped in unconfirmed mode because ALLOW_ADMIN_SETUP=true."
    );
  });

  it("should warn if no admins in DB and no credentials provided", async () => {
    // Mock empty DB for the full select
    (db.select as any).mockReturnValueOnce({
      from: vi.fn(() => []),
    });

    await bootstrapAdminIfNeeded(mockServer);

    expect(mockServer.log.warn).toHaveBeenCalledWith(
      "Bootstrap warning: No admins in DB and no ADMIN_USERNAME/ADMIN_PASSWORD provided. Login will return 503."
    );
  });
});
