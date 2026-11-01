import { z } from "zod";
import { errors } from "./errors";

// ── Strict line-item schema ────────────────────────────────────────────────────
// Only inline price_data is accepted. Stripe price IDs (platform-scoped) are
// incompatible with connected-account Checkout sessions and are rejected.
export const CURRENCY_REGEX = /^[a-z]{3}$/;
export const MAX_SAFE_AMOUNT = 99_999_999; // Stripe max for most currencies is 99999999

export const lineItemSchema = z.object({
  price_data: z.object({
    currency: z
      .string()
      .transform((v) => v.toLowerCase())
      .refine((v) => CURRENCY_REGEX.test(v), {
        message: "currency must be a 3-letter ISO code (e.g. 'usd').",
      }),
    product_data: z.object({
      name: z.string().min(1, "product name is required.").max(200),
      description: z.string().max(1000).optional(),
    }),
    unit_amount: z
      .number()
      .int("unit_amount must be an integer.")
      .positive("unit_amount must be positive.")
      .max(MAX_SAFE_AMOUNT, `unit_amount must not exceed ${MAX_SAFE_AMOUNT}.`),
  }),
  quantity: z
    .number()
    .int("quantity must be an integer.")
    .positive("quantity must be positive.")
    .max(999_999)
    .default(1),
});

// ── Metadata validation ────────────────────────────────────────────────────────
// Stripe allows max 50 metadata keys, each key max 40 chars, each value max 500 chars.
const STRIPE_METADATA_MAX_KEYS = 50;
const STRIPE_METADATA_MAX_KEY_LENGTH = 40;
const STRIPE_METADATA_MAX_VALUE_LENGTH = 500;

export function validateStripeMetadata(
  metadata: Record<string, string> | undefined
): Record<string, string> {
  if (!metadata) return {};
  const keys = Object.keys(metadata);
  if (keys.length > STRIPE_METADATA_MAX_KEYS) {
    throw errors.badRequest(`metadata must not exceed ${STRIPE_METADATA_MAX_KEYS} keys.`);
  }
  for (const key of keys) {
    if (key.length > STRIPE_METADATA_MAX_KEY_LENGTH) {
      throw errors.badRequest(
        `metadata key '${key.slice(0, 20)}...' exceeds ${STRIPE_METADATA_MAX_KEY_LENGTH} characters.`
      );
    }
    if (metadata[key].length > STRIPE_METADATA_MAX_VALUE_LENGTH) {
      throw errors.badRequest(
        `metadata value for '${key}' exceeds ${STRIPE_METADATA_MAX_VALUE_LENGTH} characters.`
      );
    }
  }
  return metadata;
}
