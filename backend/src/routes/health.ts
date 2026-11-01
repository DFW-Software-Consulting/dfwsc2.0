import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client";
import { errorLogFields } from "../lib/safe-error-log";

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async (request, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
      reply.code(200).send({
        status: "ok",
        database: "connected",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      request.log.error(errorLogFields(error), "Health check failed - database connection error");
      reply.code(503).send({
        status: "error",
        database: "disconnected",
        timestamp: new Date().toISOString(),
      });
    }
  });
}
