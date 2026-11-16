import { useCallback, useState } from "react";
import { feeTypeOf, feeValueOf } from "../utils/feeConfig";

// Fee type/value form state seeded from `source`. Changing the type clears the value and the
// form error (via `setError`).
export function useFeeConfig(source, setError) {
  const [feeType, setFeeType] = useState(() => feeTypeOf(source));
  const [feeValue, setFeeValue] = useState(() => feeValueOf(source));

  const handleFeeTypeChange = useCallback(
    (type) => {
      setFeeType(type);
      setFeeValue("");
      setError("");
    },
    [setError]
  );

  return { feeType, feeValue, setFeeValue, handleFeeTypeChange };
}
