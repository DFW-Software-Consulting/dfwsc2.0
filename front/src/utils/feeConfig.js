import { validateFeeValue, validateUrl } from "./validation";

// Fee and payment-URL handling shared by the client and group edit forms.

export function feeTypeOf(entity) {
  if (entity.processingFeePercent != null) return "percent";
  if (entity.processingFeeCents != null) return "cents";
  return "none";
}

export function feeValueOf(entity) {
  if (entity.processingFeePercent != null) return String(entity.processingFeePercent);
  if (entity.processingFeeCents != null) return String(entity.processingFeeCents);
  return "";
}

/** Returns `{ error }` for an invalid fee, otherwise the fee fields of a PATCH body. */
function buildFeeFields(feeType, feeValue) {
  if (feeType === "none") {
    return { fields: { processingFeePercent: null, processingFeeCents: null } };
  }
  const error = validateFeeValue(feeValue, feeType);
  if (error) return { error };
  if (feeType === "percent") {
    return { fields: { processingFeePercent: parseFloat(feeValue), processingFeeCents: null } };
  }
  return { fields: { processingFeeCents: parseInt(feeValue, 10), processingFeePercent: null } };
}

/** The error message for an invalid success or cancel URL in `body`, or null. */
function paymentUrlError(body) {
  if (validateUrl(body.paymentSuccessUrl)) return "Success URL must be a valid HTTPS URL.";
  if (validateUrl(body.paymentCancelUrl)) return "Cancel URL must be a valid HTTPS URL.";
  return null;
}

/**
 * Adds the fee fields to the PATCH `body`, then validates the fee and the payment URLs in it.
 * Returns the first error message (fee before URLs), or null when the body is ready to send.
 */
export function applyFeeConfig(body, feeType, feeValue) {
  const fee = buildFeeFields(feeType, feeValue);
  if (fee.error) return fee.error;
  Object.assign(body, fee.fields);
  return paymentUrlError(body);
}
