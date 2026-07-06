import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { DEFAULT_DB_POOL_MAX } from "../lib/constants";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX ?? String(DEFAULT_DB_POOL_MAX), 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  // Log and let the pool discard the dead client and reconnect on next checkout;
  // do NOT exit the process — idle-client errors (failover, brief network blips)
  // are recoverable and must not take the whole API down.
  console.error("Unexpected error on idle database client", err);
});

export const db = drizzle(pool);
export { pool };

/** A Drizzle handle: either the top-level `db` or an in-flight `tx` from `db.transaction(...)`. */
export type DbOrTx =
  | typeof db
  | (Parameters<typeof db.transaction>[0] extends (tx: infer T) => unknown ? T : never);
