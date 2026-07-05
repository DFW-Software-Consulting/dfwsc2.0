import type { FastifyPluginAsync } from "fastify";
import validator from "validator";
import { db } from "../db/client";
import { settings } from "../db/schema";
import { requireAdminJwt } from "../lib/auth";
import { errors } from "../lib/errors";
import { adminRateLimit } from "../lib/rate-limit";
import { clearSettingsCache } from "../lib/stripe-billing";

const ALLOWED_SETTING_KEYS = new Set([
  "default_fee_cents",
  "default_fee_percent",
  "company_name",
  "contact_email",
]);

const adminCrudRateLimit = adminRateLimit({
  max: 120,
  windowMs: 60_000,
});

const settingsRoutes: FastifyPluginAsync = async (app) => {
  // GET /settings - Fetch all global settings (Admin only)
  app.get("/settings", { preHandler: [requireAdminJwt, adminCrudRateLimit] }, async (req, res) => {
    const allSettings = await db.select().from(settings);

    const settingsMap = allSettings.reduce(
      (acc, s) => {
        acc[s.key] = s.value;
        return acc;
      },
      {} as Record<string, string>
    );

    const response = {
      defaultFeeCents:
        settingsMap.default_fee_cents || process.env.DEFAULT_PROCESS_FEE_CENTS || "0",
      defaultFeePercent: settingsMap.default_fee_percent || null,
      companyName: settingsMap.company_name || "DFW Software Consulting",
      contactEmail: settingsMap.contact_email || process.env.SMTP_FROM || "",
      smtpFrom: process.env.SMTP_FROM || "",
    };

    return res.status(200).send(response);
  });

  // PATCH /settings/:key - Update a specific global setting (Admin only)
  app.patch<{ Params: { key: string }; Body: { value: string } }>(
    "/settings/:key",
    { preHandler: [requireAdminJwt, adminCrudRateLimit] },
    async (req, res) => {
      const { key } = req.params;

      if (!req.body || typeof req.body !== "object" || !("value" in req.body)) {
        throw errors.badRequest("value is required.");
      }

      const { value } = req.body;

      if (!ALLOWED_SETTING_KEYS.has(key)) {
        throw errors.badRequest("Invalid setting key.");
      }

      if (value === undefined || value === null) {
        throw errors.badRequest("Value is required.");
      }

      let finalValue = String(value);

      if (key === "default_fee_cents") {
        if (!/^\d+$/.test(String(value).trim())) {
          throw errors.badRequest("Fee in cents must be a non-negative integer.");
        }
        const cents = parseInt(String(value), 10);
        if (Number.isNaN(cents) || cents < 0) {
          throw errors.badRequest("Fee in cents must be a non-negative integer.");
        }
      }
      if (key === "default_fee_percent") {
        if (value !== "") {
          const percent = parseFloat(String(value));
          if (Number.isNaN(percent) || percent < 0 || percent > 100) {
            throw errors.badRequest("Fee percent must be between 0 and 100.");
          }
        }
      }
      if (key === "company_name") {
        finalValue = String(value).trim();
        if (finalValue.length === 0 || finalValue.length > 120) {
          throw errors.badRequest("Company name must be between 1 and 120 characters.");
        }
      }
      if (key === "contact_email") {
        finalValue = String(value).trim();
        if (finalValue !== "" && !validator.isEmail(finalValue)) {
          throw errors.badRequest("Contact email must be a valid email address.");
        }
      }

      await db
        .insert(settings)
        .values({ key, value: finalValue })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: finalValue, updatedAt: new Date() },
        });

      clearSettingsCache();

      return res.status(200).send({ message: "Setting updated successfully." });
    }
  );
};

export default settingsRoutes;
