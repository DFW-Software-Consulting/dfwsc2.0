import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the migrator before importing the module under test
vi.mock("drizzle-orm/node-postgres/migrator", () => ({
  migrate: vi.fn(),
}));

// Mock the db client
vi.mock("../../db/client", () => ({
  db: {},
}));

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { runMigrations } from "../../lib/migrate";

const mockMigrate = migrate as ReturnType<typeof vi.fn>;

function makeFakeServer() {
  return {
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("runMigrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls server.log.info and does not throw when migrate resolves", async () => {
    mockMigrate.mockResolvedValue(undefined);
    const server = makeFakeServer();

    await expect(runMigrations(server as any)).resolves.toBeUndefined();

    expect(mockMigrate).toHaveBeenCalledTimes(1);
    expect(server.log.info).toHaveBeenCalledTimes(1);
    expect(server.log.error).not.toHaveBeenCalled();
  });

  it("calls server.log.error and rethrows when migrate rejects", async () => {
    const migrationError = new Error("Migration failed: connection timeout");
    mockMigrate.mockRejectedValue(migrationError);
    const server = makeFakeServer();

    await expect(runMigrations(server as any)).rejects.toThrow(
      "Migration failed: connection timeout"
    );

    expect(mockMigrate).toHaveBeenCalledTimes(1);
    expect(server.log.error).toHaveBeenCalledTimes(1);
    expect(server.log.error).toHaveBeenCalledWith(
      { err: migrationError },
      "Failed to execute database migrations."
    );
    expect(server.log.info).not.toHaveBeenCalled();
  });
});
