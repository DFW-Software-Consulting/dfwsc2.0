import { useCallback, useState } from "react";
import { applyFeeConfig } from "../utils/feeConfig";
import { useFeeConfig } from "./useFeeConfig";

// Form state for editing a group's name, fee and default payment URLs. `buildPatchBody()` clears
// the error, validates, and returns the PATCH body, or null after setting the error.
export function useGroupForm(group, nameRequiredMessage) {
  const [name, setName] = useState(group.name);
  const [successUrl, setSuccessUrl] = useState(group.paymentSuccessUrl ?? "");
  const [cancelUrl, setCancelUrl] = useState(group.paymentCancelUrl ?? "");
  const [error, setError] = useState("");
  const { feeType, feeValue, setFeeValue, handleFeeTypeChange } = useFeeConfig(group, setError);

  const buildPatchBody = useCallback(() => {
    setError("");
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(nameRequiredMessage);
      return null;
    }

    const body = {
      name: trimmedName,
      paymentSuccessUrl: successUrl.trim() || null,
      paymentCancelUrl: cancelUrl.trim() || null,
    };

    const feeError = applyFeeConfig(body, feeType, feeValue);
    if (feeError) {
      setError(feeError);
      return null;
    }
    return body;
  }, [name, successUrl, cancelUrl, feeType, feeValue, nameRequiredMessage]);

  return {
    name,
    setName,
    successUrl,
    setSuccessUrl,
    cancelUrl,
    setCancelUrl,
    error,
    setError,
    feeType,
    feeValue,
    setFeeValue,
    handleFeeTypeChange,
    buildPatchBody,
  };
}
