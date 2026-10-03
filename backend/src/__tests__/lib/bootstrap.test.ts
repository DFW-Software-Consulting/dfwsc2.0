import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/client";
import { bootstrapAdminIfNeeded } from "../../lib/bootstrap";

// Mock DB
vi.mock("../../db/client", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => []),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
  },
}));

describe("Bootstrap Lib", () => {
  let mockServer: any;

  function mockAdmins(rows: Array<Record<string, unknown>>) {
    (db.select as any).mockReturnValueOnce({ from: vi.fn(() => rows) });
  }

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

  it("should not insert when an admin exists, even under a different username (renamed at confirm)", async () => {
    mockAdmins([{ id: "1", username: "renamed-admin", setupConfirmed: true }]);

    process.env.ADMIN_USERNAME = "testadmin";
    process.env.ADMIN_PASSWORD = "testpassword";

    await bootstrapAdminIfNeeded(mockServer);

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("should warn to remove the credentials when ADMIN_PASSWORD is set and a confirmed admin exists", async () => {
    mockAdmins([{ id: "1", username: "renamed-admin", setupConfirmed: true }]);

    process.env.ADMIN_USERNAME = "testadmin";
    process.env.ADMIN_PASSWORD = "testpassword";

    await bootstrapAdminIfNeeded(mockServer);

    expect(mockServer.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/remove ADMIN_USERNAME and ADMIN_PASSWORD/)
    );
  });

  it("should name existing admins that still accept ADMIN_PASSWORD", async () => {
    mockAdmins([
      {
        id: "1",
        username: "renamed-admin",
        setupConfirmed: true,
        active: true,
        passwordHash: await bcrypt.hash("a-different-password", 4),
      },
      {
        id: "2",
        username: "testadmin",
        setupConfirmed: true,
        active: true,
        passwordHash: await bcrypt.hash("testpassword", 4),
      },
    ]);

    process.env.ADMIN_USERNAME = "testadmin";
    process.env.ADMIN_PASSWORD = "testpassword";

    await bootstrapAdminIfNeeded(mockServer);

    expect(db.insert).not.toHaveBeenCalled();
    expect(mockServer.log.warn).toHaveBeenCalledTimes(1);
    expect(mockServer.log.warn).toHaveBeenCalledWith(
      { usernames: ["testadmin"] },
      expect.stringMatching(/Change their passwords or remove the accounts/)
    );
  });

  it("should not name an inactive admin that matches ADMIN_PASSWORD", async () => {
    mockAdmins([
      {
        id: "1",
        username: "disabled",
        setupConfirmed: true,
        active: false,
        passwordHash: await bcrypt.hash("testpassword", 4),
      },
    ]);

    process.env.ADMIN_PASSWORD = "testpassword";

    await bootstrapAdminIfNeeded(mockServer);

    expect(mockServer.log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/remove ADMIN_USERNAME and ADMIN_PASSWORD/)
    );
  });

  it("should not warn when a confirmed admin exists and ADMIN_PASSWORD is unset", async () => {
    mockAdmins([{ id: "1", username: "existing", setupConfirmed: true }]);

    await bootstrapAdminIfNeeded(mockServer);

    expect(mockServer.log.warn).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("should not warn while the only admin is still unconfirmed", async () => {
    mockAdmins([{ id: "1", username: "testadmin", setupConfirmed: false }]);

    process.env.ADMIN_USERNAME = "testadmin";
    process.env.ADMIN_PASSWORD = "testpassword";

    await bootstrapAdminIfNeeded(mockServer);

    expect(mockServer.log.warn).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("should bootstrap admin if credentials provided and no admin exists", async () => {
    process.env.ADMIN_USERNAME = "newadmin";
    process.env.ADMIN_PASSWORD = "newpassword";

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

    await bootstrapAdminIfNeeded(mockServer);

    expect(db.insert).toHaveBeenCalled();
    expect(mockServer.log.info).toHaveBeenCalledWith(
      { username: "setupadmin" },
      "Admin account bootstrapped in unconfirmed mode because ALLOW_ADMIN_SETUP=true."
    );
  });

  it("should warn if no admins in DB and no credentials provided", async () => {
    await bootstrapAdminIfNeeded(mockServer);

    expect(db.insert).not.toHaveBeenCalled();
    expect(mockServer.log.warn).toHaveBeenCalledWith(
      "Bootstrap warning: No admins in DB and no ADMIN_USERNAME/ADMIN_PASSWORD provided. Login will return 503."
    );
  });
});
