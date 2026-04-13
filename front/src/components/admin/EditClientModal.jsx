import { useCallback, useEffect, useState } from "react";
import { useClient, usePatchClient } from "../../hooks/useClients";
import { useGroups } from "../../hooks/useGroups";
import { validateFeeValue, validateUrl } from "../../utils/validation";
import BaseModal from "./shared/BaseModal";
import Button from "./shared/Button";
import ErrorMessage from "./shared/ErrorMessage";
import FeeConfigSection from "./shared/FeeConfigSection";
import FormInput from "./shared/FormInput";

export default function EditClientModal({
  client,
  onClose,
  onSaved,
  showToast,
  workspace = "client_portal",
}) {
  const isDfwscMode = workspace === "dfwsc_services";
  const { data: groups = [] } = useGroups(workspace);
  const { data: fullClient, isLoading: clientLoading } = useClient(client.id, workspace);
  const patchClientMutation = usePatchClient();

  const [feeType, setFeeType] = useState("none");
  const [feeValue, setFeeValue] = useState("");
  const [groupId, setGroupId] = useState("");
  const [successUrl, setSuccessUrl] = useState("");
  const [cancelUrl, setCancelUrl] = useState("");
  const [error, setError] = useState("");

  // Profile fields (DFWSC mode only)
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [billingContactName, setBillingContactName] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("");
  const [notes, setNotes] = useState("");
  const [defaultPaymentTermsDays, setDefaultPaymentTermsDays] = useState("");

  // Populate operational fields from client prop (available immediately)
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

  // Populate profile fields from full client data once loaded
  useEffect(() => {
    if (!fullClient) return;
    setName(fullClient.name ?? "");
    setEmail(fullClient.email ?? "");
    setPhone(fullClient.phone ?? "");
    setBillingContactName(fullClient.billingContactName ?? "");
    setAddressLine1(fullClient.addressLine1 ?? "");
    setAddressLine2(fullClient.addressLine2 ?? "");
    setCity(fullClient.city ?? "");
    setState(fullClient.state ?? "");
    setPostalCode(fullClient.postalCode ?? "");
    setCountry(fullClient.country ?? "");
    setNotes(fullClient.notes ?? "");
    setDefaultPaymentTermsDays(
      fullClient.defaultPaymentTermsDays != null ? String(fullClient.defaultPaymentTermsDays) : ""
    );
  }, [fullClient]);

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

  const feeHint =
    feeType === "none"
      ? inheritedFee
        ? `Will inherit: ${inheritedFee}`
        : groupId
          ? "Group has no fee set — will fall back to platform default."
          : "Will use platform default fee."
      : null;

  const handleFeeTypeChange = useCallback((type) => {
    setFeeType(type);
    setFeeValue("");
    setError("");
  }, []);

  const handleSave = useCallback(() => {
    setError("");

    if (isDfwscMode) {
      const body = {
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || null,
        billingContactName: billingContactName.trim() || null,
        addressLine1: addressLine1.trim() || null,
        addressLine2: addressLine2.trim() || null,
        city: city.trim() || null,
        state: state.trim() || null,
        postalCode: postalCode.trim() || null,
        country: country.trim() || null,
        notes: notes.trim() || null,
        defaultPaymentTermsDays: defaultPaymentTermsDays
          ? parseInt(defaultPaymentTermsDays, 10)
          : null,
      };

      patchClientMutation.mutate(
        { id: client.id, body },
        {
          onSuccess: (updated) => {
            showToast?.("Client updated successfully", "success");
            onSaved?.(updated);
            onClose();
          },
          onError: (err) => setError(err.message),
        }
      );
      return;
    }

    const body = {
      groupId: groupId || null,
      paymentSuccessUrl: successUrl.trim() || null,
      paymentCancelUrl: cancelUrl.trim() || null,
    };

    if (feeType !== "none") {
      const feeErr = validateFeeValue(feeValue, feeType);
      if (feeErr) {
        setError(feeErr);
        return;
      }
      if (feeType === "percent") {
        body.processingFeePercent = parseFloat(feeValue);
        body.processingFeeCents = null;
      } else {
        body.processingFeeCents = parseInt(feeValue, 10);
        body.processingFeePercent = null;
      }
    } else {
      body.processingFeePercent = null;
      body.processingFeeCents = null;
    }

    if (validateUrl(body.paymentSuccessUrl)) {
      setError("Success URL must be a valid HTTPS URL.");
      return;
    }
    if (validateUrl(body.paymentCancelUrl)) {
      setError("Cancel URL must be a valid HTTPS URL.");
      return;
    }

    patchClientMutation.mutate(
      { id: client.id, body },
      {
        onSuccess: (updated) => {
          showToast?.("Client updated successfully", "success");
          onSaved?.(updated);
          onClose();
        },
        onError: (err) => setError(err.message),
      }
    );
  }, [
    client.id,
    feeType,
    feeValue,
    groupId,
    isDfwscMode,
    successUrl,
    cancelUrl,
    name,
    email,
    phone,
    billingContactName,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    country,
    notes,
    defaultPaymentTermsDays,
    onClose,
    onSaved,
    showToast,
    patchClientMutation,
  ]);

  return (
    <BaseModal isOpen onClose={onClose} title="Edit Client" titleId="edit-client-title">
      <p className="text-sm text-gray-400 mb-5">
        {client.name} &bull; {client.email}
      </p>

      {isDfwscMode && (
        <>
          {clientLoading ? (
            <p className="text-sm text-gray-400 mb-4">Loading profile...</p>
          ) : (
            <>
              <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-3">
                Contact
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <FormInput
                  id="edit-client-name"
                  label="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Acme Corp"
                />
                <FormInput
                  id="edit-client-email"
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="e.g. billing@acme.com"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <FormInput
                  id="edit-client-phone"
                  label="Phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. +1 (555) 123-4567"
                />
                <FormInput
                  id="edit-client-billing-contact"
                  label="Billing Contact Name"
                  value={billingContactName}
                  onChange={(e) => setBillingContactName(e.target.value)}
                  placeholder="e.g. John Smith"
                />
              </div>

              <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-3">
                Address
              </h3>

              <div className="mb-4">
                <FormInput
                  id="edit-client-address1"
                  label="Address Line 1"
                  value={addressLine1}
                  onChange={(e) => setAddressLine1(e.target.value)}
                  placeholder="e.g. 123 Main Street"
                />
              </div>

              <div className="mb-4">
                <FormInput
                  id="edit-client-address2"
                  label="Address Line 2"
                  value={addressLine2}
                  onChange={(e) => setAddressLine2(e.target.value)}
                  placeholder="e.g. Suite 100"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <FormInput
                  id="edit-client-city"
                  label="City"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="e.g. Dallas"
                />
                <FormInput
                  id="edit-client-state"
                  label="State"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  placeholder="e.g. TX"
                />
                <FormInput
                  id="edit-client-postal"
                  label="Postal Code"
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  placeholder="e.g. 75201"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <FormInput
                  id="edit-client-country"
                  label="Country"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder="e.g. US"
                />
                <FormInput
                  id="edit-client-payment-terms"
                  label="Default Payment Terms (days)"
                  type="number"
                  value={defaultPaymentTermsDays}
                  onChange={(e) => setDefaultPaymentTermsDays(e.target.value)}
                  placeholder="e.g. 30"
                />
              </div>

              <div className="mb-4">
                <label
                  htmlFor="edit-client-notes"
                  className="block text-sm font-medium text-gray-300 mb-1"
                >
                  Notes
                </label>
                <textarea
                  id="edit-client-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any additional notes..."
                  rows={3}
                  className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                           focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </>
          )}
        </>
      )}

      {!isDfwscMode && (
        <>
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

          <FeeConfigSection
            feeType={feeType}
            feeValue={feeValue}
            onFeeTypeChange={handleFeeTypeChange}
            onFeeValueChange={setFeeValue}
            hint={feeHint}
            hintColor={inheritedFee ? "blue" : "gray"}
            radioName="feeType"
            showInheritOption
          />

          <FormInput
            id="edit-client-success-url"
            label="Payment Success URL"
            type="url"
            value={successUrl}
            onChange={(e) => setSuccessUrl(e.target.value)}
            placeholder="https://yoursite.com/thank-you"
            wrapperClassName="mb-4"
          />
          <FormInput
            id="edit-client-cancel-url"
            label="Payment Cancel URL"
            type="url"
            value={cancelUrl}
            onChange={(e) => setCancelUrl(e.target.value)}
            placeholder="https://yoursite.com/cancel"
            wrapperClassName="mb-5"
          />
        </>
      )}

      <ErrorMessage message={error} className="mb-3" />

      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" isLoading={patchClientMutation.isPending} onClick={handleSave}>
          {patchClientMutation.isPending ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </BaseModal>
  );
}
