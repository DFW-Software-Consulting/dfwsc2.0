import { useCallback, useEffect, useRef, useState } from "react";
import logger from "../../utils/logger";

export default function EditClientModal({ client, groups, onClose, onSaved, showToast }) {
  const [feeType, setFeeType] = useState("none");
  const [feeValue, setFeeValue] = useState("");
  const [groupId, setGroupId] = useState("");
  const [successUrl, setSuccessUrl] = useState("");
  const [cancelUrl, setCancelUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const modalRef = useRef(null);

  useEffect(() => {
    if (client.processingFeePercent != null) {
      setFeeType("percent");
      setFeeValue(String(client.processingFeePercent));
    } else if (client.processingFeeCents != null) {
      setFeeType("cents");
      setFeeValue(String(client.processingFeeCents));
    } else {
      setFeeType("none");
      setFeeValue("");
    }
    setGroupId(client.groupId ?? "");
    setSuccessUrl(client.paymentSuccessUrl ?? "");
    setCancelUrl(client.paymentCancelUrl ?? "");
  }, [client]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const handleBackdropClick = (e) => {
    if (e.target === modalRef.current) onClose();
  };

  const inheritedFee = (() => {
    if (feeType !== "none" || !groupId) return null;
    const group = groups.find((g) => g.id === groupId);
    if (!group) return null;
    if (group.processingFeePercent != null)
      return `${group.processingFeePercent}% (from group "${group.name}")`;
    if (group.processingFeeCents != null)
      return `$${(group.processingFeeCents / 100).toFixed(2)} flat (from group "${group.name}")`;
    return null;
  })();

  const handleSave = useCallback(async () => {
    const token = sessionStorage.getItem("adminToken");
    if (!token) return;

    setError("");
    const body = {
      groupId: groupId || null,
      paymentSuccessUrl: successUrl.trim() || null,
      paymentCancelUrl: cancelUrl.trim() || null,
    };

    if (feeType === "percent") {
      const v = parseFloat(feeValue);
      if (Number.isNaN(v) || v <= 0 || v > 100) {
        setError("Fee percent must be greater than 0 and at most 100.");
        return;
      }
      body.processingFeePercent = v;
      body.processingFeeCents = null;
    } else if (feeType === "cents") {
      const v = parseInt(feeValue, 10);
      if (Number.isNaN(v) || v < 0 || !Number.isInteger(v)) {
        setError("Fee must be a non-negative whole number of cents.");
        return;
      }
      body.processingFeeCents = v;
      body.processingFeePercent = null;
    } else {
      body.processingFeePercent = null;
      body.processingFeeCents = null;
    }

    if (body.paymentSuccessUrl && !body.paymentSuccessUrl.startsWith("https://")) {
      setError("Success URL must be a valid HTTPS URL.");
      return;
    }
    if (body.paymentCancelUrl && !body.paymentCancelUrl.startsWith("https://")) {
      setError("Cancel URL must be a valid HTTPS URL.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/clients/${client.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed to update client" }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const updated = await res.json();
      showToast?.("Client updated successfully", "success");
      onSaved?.(updated);
      onClose();
    } catch (err) {
      logger.error("Error updating client:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [client.id, feeType, feeValue, groupId, successUrl, cancelUrl, onClose, onSaved, showToast]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled via document-level keydown listener
    <div
      ref={modalRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-client-title"
    >
      <div className="bg-gray-800 rounded-xl shadow-xl border border-gray-700 p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 id="edit-client-title" className="text-lg font-semibold text-white">
            Edit Client
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white text-2xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <p className="text-sm text-gray-400 mb-5">
          {client.name} &bull; {client.email}
        </p>

        {/* Group assignment */}
        <div className="mb-4">
          <label
            htmlFor="edit-client-group"
            className="block text-sm font-medium text-gray-300 mb-1"
          >
            Group
          </label>
          <select
            id="edit-client-group"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                       focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">— No group —</option>
            {groups
              .filter((g) => g.status === "active")
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
        </div>

        {/* Processing fee */}
        <div className="mb-4">
          <label
            htmlFor="edit-client-fee-value"
            className="block text-sm font-medium text-gray-300 mb-2"
          >
            Processing Fee
          </label>
          <div className="flex flex-wrap gap-4 mb-2">
            {[
              { value: "none", label: "Inherit / None" },
              { value: "percent", label: "Percent (%)" },
              { value: "cents", label: "Flat (cents)" },
            ].map(({ value, label }) => (
              <label
                key={value}
                className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer"
              >
                <input
                  type="radio"
                  name="feeType"
                  value={value}
                  checked={feeType === value}
                  onChange={() => {
                    setFeeType(value);
                    setFeeValue("");
                    setError("");
                  }}
                  className="accent-blue-500"
                />
                {label}
              </label>
            ))}
          </div>
          {feeType !== "none" && (
            <input
              id="edit-client-fee-value"
              type="number"
              value={feeValue}
              onChange={(e) => setFeeValue(e.target.value)}
              placeholder={feeType === "percent" ? "e.g. 2.5" : "e.g. 50  (= $0.50)"}
              min="0"
              step={feeType === "percent" ? "0.01" : "1"}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
          {inheritedFee && (
            <p className="mt-1.5 text-xs text-blue-400">Will inherit: {inheritedFee}</p>
          )}
          {feeType === "none" && !inheritedFee && groupId && (
            <p className="mt-1.5 text-xs text-gray-400">
              Group has no fee set — will fall back to platform default.
            </p>
          )}
          {feeType === "none" && !groupId && (
            <p className="mt-1.5 text-xs text-gray-400">Will use platform default fee.</p>
          )}
        </div>

        {/* Redirect URLs */}
        <div className="mb-4">
          <label
            htmlFor="edit-client-success-url"
            className="block text-sm font-medium text-gray-300 mb-1"
          >
            Payment Success URL
          </label>
          <input
            id="edit-client-success-url"
            type="url"
            value={successUrl}
            onChange={(e) => setSuccessUrl(e.target.value)}
            placeholder="https://yoursite.com/thank-you"
            className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                       placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="mb-5">
          <label
            htmlFor="edit-client-cancel-url"
            className="block text-sm font-medium text-gray-300 mb-1"
          >
            Payment Cancel URL
          </label>
          <input
            id="edit-client-cancel-url"
            type="url"
            value={cancelUrl}
            onChange={(e) => setCancelUrl(e.target.value)}
            placeholder="https://yoursite.com/cancel"
            className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                       placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {error && (
          <p className="mb-3 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md bg-gray-700 hover:bg-gray-600 text-white font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={loading}
            className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
