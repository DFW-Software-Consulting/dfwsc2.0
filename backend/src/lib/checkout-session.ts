import type Stripe from "stripe";
import type { z } from "zod";
import { appendCheckoutSessionId } from "./config";
import { errors } from "./errors";
import { CURRENCY_REGEX, type lineItemSchema, MAX_SAFE_AMOUNT } from "./stripe-input";

export type CheckoutLineItemInput = z.infer<typeof lineItemSchema>;

// Stripe limits idempotency keys to 255 characters.
const STRIPE_IDEMPOTENCY_KEY_MAX = 255;

// Keys are scoped per client: namespace the key sent to Stripe so two clients using the same
// key never collide on the platform. The namespaced key must fit Stripe's length limit.
export function buildStripeIdempotencyKey(clientId: string, idempotencyKey: string): string {
  const stripeIdempotencyKey = `${clientId}:${idempotencyKey}`;
  if (stripeIdempotencyKey.length > STRIPE_IDEMPOTENCY_KEY_MAX) {
    throw errors.badRequest(
      `Idempotency-Key must not exceed ${STRIPE_IDEMPOTENCY_KEY_MAX - clientId.length - 1} characters.`
    );
  }
  return stripeIdempotencyKey;
}

export function assertLineItemCount(lineItems: CheckoutLineItemInput[] | undefined): void {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw errors.badRequest("lineItems are required.");
  }
  if (lineItems.length > 100) {
    throw errors.badRequest("lineItems must not exceed 100 items.");
  }
}

// Derive baseAmount strictly from line items server-side. The caller-supplied `amount` is
// ignored for Checkout to prevent fee integrity attacks where a caller sends a lower amount
// than the line items imply.
export function computeBaseAmount(lineItems: CheckoutLineItemInput[]): {
  baseAmount: number;
  lineItemCurrency: string | undefined;
} {
  let baseAmount = 0;
  let lineItemCurrency: string | undefined;
  for (const item of lineItems) {
    const unitAmount = item.price_data.unit_amount;
    const qty = item.quantity;
    const lineTotal = unitAmount * qty;
    if (!Number.isSafeInteger(lineTotal) || lineTotal > MAX_SAFE_AMOUNT * 999_999) {
      throw errors.badRequest("Line item total exceeds safe integer bounds.");
    }
    baseAmount += lineTotal;
    if (!lineItemCurrency) {
      lineItemCurrency = item.price_data.currency;
    } else if (lineItemCurrency !== item.price_data.currency) {
      throw errors.badRequest("All line items must use the same currency.");
    }
  }

  if (baseAmount <= 0) {
    throw errors.badRequest("Computed base amount must be positive.");
  }

  if (!Number.isSafeInteger(baseAmount)) {
    throw errors.badRequest("Computed base amount exceeds safe integer bounds.");
  }

  return { baseAmount, lineItemCurrency };
}

export function resolveCheckoutCurrency(
  lineItemCurrency: string | undefined,
  currency: string | undefined
): string {
  const resolvedCurrency = lineItemCurrency ?? currency;
  if (!resolvedCurrency || !CURRENCY_REGEX.test(resolvedCurrency)) {
    throw errors.badRequest("currency must be a 3-letter ISO code (e.g. 'usd').");
  }
  return resolvedCurrency;
}

export function assertValidFee(feeAmount: number): void {
  if (!Number.isSafeInteger(feeAmount) || feeAmount < 0) {
    throw errors.badRequest("Computed fee is invalid.");
  }
}

// Caller line items, plus a trailing "Processing Fee" line when a fee applies and is not waived.
export function buildCheckoutLineItems(
  lineItems: CheckoutLineItemInput[],
  fee: { amount: number; waived: boolean; currency: string }
): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const checkoutLineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = lineItems.map(
    (item) => ({
      price_data: {
        currency: item.price_data.currency,
        product_data: {
          name: item.price_data.product_data.name,
          ...(item.price_data.product_data.description
            ? { description: item.price_data.product_data.description }
            : {}),
        },
        unit_amount: item.price_data.unit_amount,
      },
      quantity: item.quantity,
    })
  );

  if (fee.amount > 0 && !fee.waived) {
    checkoutLineItems.push({
      price_data: {
        currency: fee.currency,
        product_data: {
          name: "Processing Fee",
        },
        unit_amount: fee.amount,
      },
      quantity: 1,
    });
  }
  return checkoutLineItems;
}

export function computeTotalAmount(baseAmount: number, feeAmount: number, waived: boolean): number {
  return waived ? baseAmount : baseAmount + feeAmount;
}

export interface CheckoutSessionParamsInput {
  checkoutLineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
  successUrl: string | null | undefined;
  cancelUrl: string | null | undefined;
  // Only read when successUrl or cancelUrl is missing.
  frontendOrigin: string | undefined;
  description: string | undefined;
  userMetadata: Record<string, string>;
  clientId: string;
  baseAmount: number;
  feeAmount: number;
  waived: boolean;
}

export function buildCheckoutSessionParams(
  input: CheckoutSessionParamsInput
): Stripe.Checkout.SessionCreateParams {
  const { successUrl, cancelUrl, frontendOrigin, clientId, baseAmount, feeAmount, waived } = input;
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    line_items: input.checkoutLineItems,
    success_url: appendCheckoutSessionId(
      successUrl ?? `${frontendOrigin}/payment-success?session_id={CHECKOUT_SESSION_ID}`
    ),
    cancel_url: cancelUrl ?? `${frontendOrigin}/payment-cancel`,
    payment_intent_data: {
      description: input.description,
      metadata: {
        ...input.userMetadata,
        clientId,
        baseAmount: baseAmount.toString(),
        feeAmount: waived ? "0" : feeAmount.toString(),
        waivedFeeAmount: waived ? feeAmount.toString() : "0",
      },
    },
    metadata: {
      clientId,
    },
  };
  if (sessionParams.payment_intent_data && !waived) {
    sessionParams.payment_intent_data.application_fee_amount = feeAmount;
  }
  return sessionParams;
}
