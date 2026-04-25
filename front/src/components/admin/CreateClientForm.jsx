import { useCallback, useState } from "react";
import { useCreateClient, useDfwscClient } from "../../hooks/useClients";
import { useGroups } from "../../hooks/useGroups";
import logger from "../../utils/logger";
import { validateEmail, validateName } from "../../utils/validation";
import Button from "./shared/Button";
import ErrorMessage from "./shared/ErrorMessage";
import FormInput from "./shared/FormInput";

const NAME_MAX_LENGTH = 100;

export default function CreateClientForm({ showToast, workspace = "client_portal", onSuccess }) {
  const isDfwscMode = workspace === "dfwsc_services";
  const isLedgerMode = workspace === "ledger_crm";
  const isPortalMode = workspace === "client_portal";
  const { data: groups = [] } = useGroups(workspace);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [groupId, setGroupId] = useState("");
  const [error, setError] = useState("");
  const [createdClientInfo, setCreatedClientInfo] = useState(null);

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

  const createClientMutation = useCreateClient();
  const dfwscClientMutation = useDfwscClient();

  const validateForm = useCallback(() => {
    const nameErr = validateName(name, 1, NAME_MAX_LENGTH, "Client name");
    if (nameErr) return nameErr;
    const emailErr = validateEmail(email);
    if (emailErr) return emailErr;
    return null;
  }, [name, email]);

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      setError("");
      setCreatedClientInfo(null);

      if (isDfwscMode) {
        dfwscClientMutation.mutate(
          {
            name: name.trim(),
            email: email.trim(),
            phone: phone.trim() || undefined,
            billingContactName: billingContactName.trim() || undefined,
            addressLine1: addressLine1.trim() || undefined,
            addressLine2: addressLine2.trim() || undefined,
            city: city.trim() || undefined,
            state: state.trim() || undefined,
            postalCode: postalCode.trim() || undefined,
            country: country.trim() || undefined,
            notes: notes.trim() || undefined,
            defaultPaymentTermsDays: defaultPaymentTermsDays
              ? parseInt(defaultPaymentTermsDays, 10)
              : undefined,
          },
          {
            onSuccess: (data) => {
              setCreatedClientInfo(data);
              setName("");
              setEmail("");
              setPhone("");
              setBillingContactName("");
              setAddressLine1("");
              setAddressLine2("");
              setCity("");
              setState("");
              setPostalCode("");
              setCountry("");
              setNotes("");
              setDefaultPaymentTermsDays("");
              showToast?.(`Client ${data.name} created successfully!`, "success");
              onSuccess?.(data);
            },
            onError: (err) => {
              logger.error("Error creating DFWSC client:", err);
              setError(err.message);
              showToast?.(`Error creating client: ${err.message}`, "error");
            },
          }
        );
        return;
      }

      if (isLedgerMode) {
        createClientMutation.mutate(
          {
            name: name.trim(),
            email: email.trim(),
            workspace,
          },
          {
            onSuccess: (data) => {
              setCreatedClientInfo(data);
              setName("");
              setEmail("");
              showToast?.(`Client ${data.name} created successfully!`, "success");
              onSuccess?.(data);
            },
            onError: (err) => {
              logger.error("Error creating ledger client:", err);
              setError(err.message);
              showToast?.(`Error creating client: ${err.message}`, "error");
            },
          }
        );
        return;
      }

      const validationError = validateForm();
      if (validationError) {
        setError(validationError);
        return;
      }

      createClientMutation.mutate(
        {
          name: name.trim(),
          email: email.trim(),
          workspace,
          groupId: groupId ? groupId : undefined,
        },
        {
          onSuccess: (data) => {
            setCreatedClientInfo(data);
            setName("");
            setEmail("");
            setGroupId("");
            showToast?.(`Client ${data.name} created successfully!`, "success");
            onSuccess?.(data);
          },
          onError: (err) => {
            logger.error("Error creating client:", err);
            setError(err.message);
            showToast?.(`Error creating client: ${err.message}`, "error");
          },
        }
      );
    },
    [
      name,
      email,
      groupId,
      workspace,
      validateForm,
      createClientMutation,
      showToast,
      isDfwscMode,
      isLedgerMode,
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
      dfwscClientMutation,
      onSuccess,
    ]
  );

  const copyToClipboard = useCallback(
    async (text, type) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast?.(`${type} copied to clipboard!`, "success");
      } catch (err) {
        logger.error(`Failed to copy ${type}:`, err);
        showToast?.(`Failed to copy ${type}`, "error");
      }
    },
    [showToast]
  );

  const canSubmit = !!name.trim() && !!email.trim();

  const mutation = isDfwscMode ? dfwscClientMutation : createClientMutation;

  return (
    <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
      <h4 className="text-md font-semibold text-white mb-3">Create New Client</h4>

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <FormInput
            id="newClientName"
            label="Account Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Marketing"
            maxLength={NAME_MAX_LENGTH}
            disabled={mutation.isPending}
            helper={`${name.length}/${NAME_MAX_LENGTH} characters`}
          />
          <FormInput
            id="newClientEmail"
            label="Account Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="e.g. payments@acme.com"
            disabled={mutation.isPending}
          />
        </div>

        {isDfwscMode && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <FormInput
                id="newClientPhone"
                label="Phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="e.g. +1 (555) 123-4567"
                disabled={mutation.isPending}
              />
              <FormInput
                id="billingContactName"
                label="Billing Contact Name"
                value={billingContactName}
                onChange={(e) => setBillingContactName(e.target.value)}
                placeholder="e.g. John Smith"
                disabled={mutation.isPending}
              />
            </div>

            <div className="mb-4">
              <FormInput
                id="addressLine1"
                label="Address Line 1"
                value={addressLine1}
                onChange={(e) => setAddressLine1(e.target.value)}
                placeholder="e.g. 123 Main Street"
                disabled={mutation.isPending}
              />
            </div>

            <div className="mb-4">
              <FormInput
                id="addressLine2"
                label="Address Line 2"
                value={addressLine2}
                onChange={(e) => setAddressLine2(e.target.value)}
                placeholder="e.g. Suite 100"
                disabled={mutation.isPending}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <FormInput
                id="city"
                label="City"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Austin"
                disabled={mutation.isPending}
              />
              <FormInput
                id="state"
                label="State"
                value={state}
                onChange={(e) => setState(e.target.value)}
                placeholder="e.g. TX"
                disabled={mutation.isPending}
              />
              <FormInput
                id="postalCode"
                label="Postal Code"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                placeholder="e.g. 78701"
                disabled={mutation.isPending}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <FormInput
                id="country"
                label="Country"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="e.g. US"
                disabled={mutation.isPending}
              />
              <FormInput
                id="defaultPaymentTermsDays"
                label="Default Payment Terms (days)"
                type="number"
                value={defaultPaymentTermsDays}
                onChange={(e) => setDefaultPaymentTermsDays(e.target.value)}
                placeholder="e.g. 30"
                disabled={mutation.isPending}
              />
            </div>

            <div className="mb-4">
              <label htmlFor="notes" className="block text-sm font-medium text-gray-300 mb-1">
                Notes (Optional)
              </label>
              <textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Any additional notes..."
                rows={3}
                className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                       focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={mutation.isPending}
              />
            </div>
          </>
        )}

        {isPortalMode && (
          <div className="mb-4">
            <label
              htmlFor="newClientGroup"
              className="block text-sm font-medium text-gray-300 mb-1"
            >
              Assign to Company (Optional)
            </label>
            <select
              id="newClientGroup"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="w-full md:w-1/2 rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                       focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={mutation.isPending}
            >
              <option value="">— No company (Independent Account) —</option>
              {groups
                .filter((g) => g.status === "active")
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Grouping accounts allows you to manage them under a single client profile.
            </p>
          </div>
        )}

        <Button
          type="submit"
          disabled={mutation.isPending || !canSubmit}
          isLoading={mutation.isPending}
          className="w-full md:w-auto shadow-lg focus:ring-2 focus:ring-blue-400"
        >
          {mutation.isPending ? "Creating..." : "Create Client"}
        </Button>

        <ErrorMessage message={error} className="mt-2" />
      </form>

      {createdClientInfo && isPortalMode && (
        <div className="mt-4 p-4 bg-gray-800/50 rounded-lg border border-gray-600">
          <h5 className="font-semibold text-green-400 mb-2">Client Created Successfully!</h5>

          {createdClientInfo.apiKey && (
            <div className="mb-4 p-3 bg-red-900/20 border border-red-500/30 rounded-md">
              <p className="text-sm text-red-300 font-bold mb-1">⚠️ API KEY (SHOWN ONLY ONCE):</p>
              <div className="flex items-center">
                <code className="flex-1 bg-gray-900/50 text-red-300 p-2 rounded break-all mr-2 font-mono text-xs">
                  {createdClientInfo.apiKey}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(createdClientInfo.apiKey, "API Key")}
                  className="text-sm bg-red-800/40 hover:bg-red-800/60 text-white py-1 px-3 rounded transition-colors"
                >
                  Copy
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-2 italic">
                Treat this key like a password. It cannot be recovered if lost.
              </p>
            </div>
          )}

          <div className="mb-3">
            <p className="text-sm text-gray-300 mb-1">
              <strong>Client ID:</strong>
            </p>
            <div className="flex items-center">
              <code className="flex-1 bg-gray-900/50 text-gray-300 p-2 rounded break-all mr-2 text-xs">
                {createdClientInfo.clientId}
              </code>
              <button
                type="button"
                onClick={() => copyToClipboard(createdClientInfo.clientId, "Client ID")}
                className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded transition-colors"
              >
                Copy
              </button>
            </div>
          </div>

          <div className="mb-3">
            <p className="text-sm text-gray-300 mb-1">
              <strong>Onboarding Token:</strong>
            </p>
            <div className="flex items-center">
              <code className="flex-1 bg-gray-900/50 text-green-300 p-2 rounded break-all mr-2 text-xs">
                {createdClientInfo.onboardingToken}
              </code>
              <button
                type="button"
                onClick={() => copyToClipboard(createdClientInfo.onboardingToken, "Token")}
                className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded transition-colors"
              >
                Copy
              </button>
            </div>
          </div>

          <div>
            <p className="text-sm text-gray-300 mb-1">
              <strong>Onboarding URL:</strong>
            </p>
            <div className="flex items-center">
              <code className="flex-1 bg-gray-900/50 text-blue-300 p-2 rounded break-all mr-2 text-xs">
                {createdClientInfo.onboardingUrlHint}
              </code>
              <button
                type="button"
                onClick={() => copyToClipboard(createdClientInfo.onboardingUrlHint, "URL")}
                className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded transition-colors"
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
