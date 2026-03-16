import { useCallback, useState } from "react";
import { useCreateClient } from "../../hooks/useClients";
import logger from "../../utils/logger";
import { validateEmail, validateName } from "../../utils/validation";
import Button from "./shared/Button";
import ErrorMessage from "./shared/ErrorMessage";
import FormInput from "./shared/FormInput";

const NAME_MAX_LENGTH = 100;

export default function CreateClientForm({ showToast }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
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
        { name: name.trim(), email: email.trim() },
        {
          onSuccess: (data) => {
            setCreatedClientInfo(data);
            setName("");
            setEmail("");
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
    [name, email, validateForm, createClientMutation, showToast]
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
            label="Client Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter client name"
            maxLength={NAME_MAX_LENGTH}
            disabled={createClientMutation.isPending}
            helper={`${name.length}/${NAME_MAX_LENGTH} characters`}
          />
          <FormInput
            id="newClientEmail"
            label="Client Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter client email"
            disabled={createClientMutation.isPending}
          />
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

          <div className="mb-3">
            <p className="text-sm text-gray-300 mb-1">
              <strong>Onboarding Token:</strong>
            </p>
            <div className="flex items-center">
              <code className="flex-1 bg-gray-900/50 text-green-300 p-2 rounded break-all mr-2">
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
              <code className="flex-1 bg-gray-900/50 text-blue-300 p-2 rounded break-all mr-2">
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
