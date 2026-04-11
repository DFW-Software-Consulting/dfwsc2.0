import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db/client";
import { settings } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";

const settingsRoutes: FastifyPluginAsync = async (app) => {
  // GET /settings - Fetch all global settings (Admin only)
  app.get("/settings", { preHandler: requireAdminJwt }, async (req, res) => {
    try {
      const allSettings = await db.select().from(settings);

      // Convert to a cleaner object for the frontend
      const settingsMap = allSettings.reduce(
        (acc, s) => {
          acc[s.key] = s.value;
          return acc;
        },
        {} as Record<string, string>
      );

      // Provide defaults if not set in DB
      const response = {
        defaultFeeCents:
          settingsMap["default_fee_cents"] || process.env.DEFAULT_PROCESS_FEE_CENTS || "0",
        defaultFeePercent: settingsMap["default_fee_percent"] || null,
        companyName: settingsMap["company_name"] || "DFW Software Consulting",
        contactEmail: settingsMap["contact_email"] || process.env.SMTP_FROM || "",
      };

      return res.status(200).send(response);
    } catch (error) {
      req.log.error(error, "Error fetching settings");
      return res.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /settings/:key - Update a specific global setting (Admin only)
  app.patch<{ Params: { key: string }; Body: { value: string } }>(
    "/settings/:key",
    { preHandler: requireAdminJwt },
    async (req, res) => {
      try {
        const { key } = req.params;
        const { value } = req.body;

        if (value === undefined || value === null) {
          return res.status(400).send({ error: "Value is required." });
        }

        // Validation for specific keys
        if (key === "default_fee_cents") {
          const cents = parseInt(value, 10);
          if (isNaN(cents) || cents < 0) {
            return res.status(400).send({ error: "Fee in cents must be a non-negative integer." });
          }
        }
        if (key === "default_fee_percent") {
          if (value !== "") {
            const percent = parseFloat(value);
            if (isNaN(percent) || percent < 0 || percent > 100) {
              return res.status(400).send({ error: "Fee percent must be between 0 and 100." });
            }
          }
        }

        // Upsert setting
        const [existing] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);

        if (existing) {
          await db
            .update(settings)
            .set({ value: String(value), updatedAt: new Date() })
            .where(eq(settings.key, key));
        } else {
          await db.insert(settings).values({
            key,
            value: String(value),
          });
        }

        return res.status(200).send({ message: "Setting updated successfully." });
      } catch (error) {
        req.log.error(error, "Error updating setting");
        return res.status(500).send({ error: "Internal server error" });
      }
    }
  );
};

export default settingsRoutes;
