import { useState, useCallback } from "react";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 100;

export default function CreateClientForm({ onClientCreated, showToast }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [createdClientInfo, setCreatedClientInfo] = useState(null);

  const validateForm = useCallback(() => {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName) {
      return "Client name is required";
    }
    if (trimmedName.length < NAME_MIN_LENGTH || trimmedName.length > NAME_MAX_LENGTH) {
      return `Name must be between ${NAME_MIN_LENGTH} and ${NAME_MAX_LENGTH} characters`;
    }
    if (!trimmedEmail) {
      return "Client email is required";
    }
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      return "Please enter a valid email address";
    }
    return null;
  }, [name, email]);

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();

      const validationError = validateForm();
      if (validationError) {
        setError(validationError);
        return;
      }

      setLoading(true);
      setError("");
      setCreatedClientInfo(null);

      try {
        const token = sessionStorage.getItem("adminToken");
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/v1/accounts`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              name: name.trim(),
              email: email.trim(),
            }),
          }
        );

        if (!res.ok) {
          const errorData = await res
            .json()
            .catch(() => ({ error: "Failed to create client" }));
          throw new Error(
            errorData.error || `HTTP ${res.status}: ${res.statusText}`
          );
        }

        const data = await res.json();
        setCreatedClientInfo(data);
        setName("");
        setEmail("");

        showToast?.(`Client ${data.name} created successfully!`, "success");
        onClientCreated?.(data);
      } catch (err) {
        console.error("Error creating client:", err);
        setError(err.message);
        showToast?.(`Error creating client: ${err.message}`, "error");
      } finally {
        setLoading(false);
      }
    },
    [name, email, validateForm, onClientCreated, showToast]
  );

  const copyToClipboard = useCallback(
    async (text, type) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast?.(`${type} copied to clipboard!`, "success");
      } catch (err) {
        console.error(`Failed to copy ${type}:`, err);
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
          <div>
            <label
              htmlFor="newClientName"
              className="block text-sm font-medium text-gray-300 mb-1"
            >
              Client Name
            </label>
            <input
              id="newClientName"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter client name"
              maxLength={NAME_MAX_LENGTH}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50
                         px-3 py-2 text-gray-100 placeholder-gray-500
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              disabled={loading}
            />
            <p className="mt-1 text-xs text-gray-400">
              {name.length}/{NAME_MAX_LENGTH} characters
            </p>
          </div>

          <div>
            <label
              htmlFor="newClientEmail"
              className="block text-sm font-medium text-gray-300 mb-1"
            >
              Client Email
            </label>
            <input
              id="newClientEmail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter client email"
              className="w-full rounded-md border border-gray-600 bg-gray-900/50
                         px-3 py-2 text-gray-100 placeholder-gray-500
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              disabled={loading}
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading || !name.trim() || !email.trim()}
          className="w-full md:w-auto rounded-md bg-blue-600 hover:bg-blue-700
                     text-white font-semibold py-2 px-4 shadow-lg
                     transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-400
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Creating..." : "Create Client"}
        </button>

        {error && (
          <p className="mt-2 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
      </form>

      {createdClientInfo && (
        <div className="mt-4 p-4 bg-gray-800/50 rounded-lg border border-gray-600">
          <h5 className="font-semibold text-green-400 mb-2">
            Client Created Successfully!
          </h5>

          <div className="mb-3">
            <p className="text-sm text-gray-300 mb-1">
              <strong>Onboarding Token:</strong>
            </p>
            <div className="flex items-center">
              <code className="flex-1 bg-gray-900/50 text-green-300 p-2 rounded break-all mr-2">
                {createdClientInfo.onboardingToken}
              </code>
              <button
                onClick={() =>
                  copyToClipboard(createdClientInfo.onboardingToken, "Token")
                }
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
                onClick={() =>
                  copyToClipboard(createdClientInfo.onboardingUrlHint, "URL")
                }
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
