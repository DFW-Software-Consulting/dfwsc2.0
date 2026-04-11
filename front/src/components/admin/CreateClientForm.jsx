import { useCallback, useState } from "react";
import { useCreateClient } from "../../hooks/useClients";
import { useGroups } from "../../hooks/useGroups";
import logger from "../../utils/logger";
import { validateEmail, validateName } from "../../utils/validation";
import Button from "./shared/Button";
import ErrorMessage from "./shared/ErrorMessage";
import FormInput from "./shared/FormInput";

const NAME_MAX_LENGTH = 100;

export default function CreateClientForm({ showToast }) {
  const { data: groups = [] } = useGroups();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [groupId, setGroupId] = useState("");
  const [error, setError] = useState("");
  const [createdClientInfo, setCreatedClientInfo] = useState(null);

  const createClientMutation = useCreateClient();

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
      const validationError = validateForm();
      if (validationError) {
        setError(validationError);
        return;
      }
      setError("");
      setCreatedClientInfo(null);
      createClientMutation.mutate(
        { name: name.trim(), email: email.trim(), groupId: groupId || undefined },
        {
          onSuccess: (data) => {
            setCreatedClientInfo(data);
            setName("");
            setEmail("");
            setGroupId("");
            showToast?.(`Client ${data.name} created successfully!`, "success");
          },
          onError: (err) => {
            logger.error("Error creating client:", err);
            setError(err.message);
            showToast?.(`Error creating client: ${err.message}`, "error");
          },
        }
      );
    },
    [name, email, groupId, validateForm, createClientMutation, showToast]
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
            disabled={createClientMutation.isPending}
            helper={`${name.length}/${NAME_MAX_LENGTH} characters`}
          />
          <FormInput
            id="newClientEmail"
            label="Account Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="e.g. payments@acme.com"
            disabled={createClientMutation.isPending}
          />
        </div>

        <div className="mb-4">
          <label htmlFor="newClientGroup" className="block text-sm font-medium text-gray-300 mb-1">
            Assign to Company (Optional)
          </label>
          <select
            id="newClientGroup"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="w-full md:w-1/2 rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                       focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={createClientMutation.isPending}
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

        <Button
          type="submit"
          disabled={createClientMutation.isPending || !name.trim() || !email.trim()}
          isLoading={createClientMutation.isPending}
          className="w-full md:w-auto shadow-lg focus:ring-2 focus:ring-blue-400"
        >
          {createClientMutation.isPending ? "Creating..." : "Create Client"}
        </Button>

        <ErrorMessage message={error} className="mt-2" />
      </form>

      {createdClientInfo && (
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
