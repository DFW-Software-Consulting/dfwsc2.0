import { useState, useCallback } from "react";
import logger from "../../utils/logger";

const MIN_PASSWORD_LENGTH = 8;

export default function AdminSetup({ onSetupComplete, showToast, setupToken }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  const validateForm = useCallback(() => {
    if (!username.trim()) {
      return "Username is required";
    }
    if (username.trim().length < 3) {
      return "Username must be at least 3 characters";
    }
    if (!password) {
      return "Password is required";
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    if (password !== confirmPassword) {
      return "Passwords do not match";
    }
    return null;
  }, [username, password, confirmPassword]);

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

      try {
        const headers = {
          "Content-Type": "application/json",
        };

        if (setupToken) {
          headers["X-Setup-Token"] = setupToken;
        }

        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/auth/setup`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              username: username.trim(),
              password,
            }),
          }
        );

        if (!res.ok) {
          const errorData = await res
            .json()
            .catch(() => ({ error: "Setup failed" }));
          throw new Error(errorData.error || "Setup failed");
        }

        const data = await res.json();
        setResult(data);
        showToast?.("Admin credentials generated successfully!", "success");
      } catch (err) {
        logger.error("Admin setup error:", err);
        setError(err.message || "Setup failed");
        showToast?.(err.message || "Setup failed", "error");
      } finally {
        setLoading(false);
      }
    },
    [username, password, confirmPassword, validateForm, showToast, setupToken]
  );

  const handleCopyCredentials = useCallback(async () => {
    if (!result) return;

    const envConfig = `ADMIN_USERNAME=${result.username}\nADMIN_PASSWORD=${result.passwordHash}`;

    try {
      await navigator.clipboard.writeText(envConfig);
      setCopied(true);
      showToast?.("Credentials copied to clipboard!", "success");
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      logger.error("Failed to copy credentials:", err);
      showToast?.("Failed to copy to clipboard", "error");
    }
  }, [result, showToast]);

  if (result) {
    return (
      <div className="space-y-4">
        <div className="bg-green-900/30 border border-green-600 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-green-400 mb-2">
            Admin Credentials Generated
          </h3>
          <p className="text-sm text-gray-300 mb-4">
            Copy these credentials and add them to your environment configuration.
            This setup can only be done once.
          </p>
        </div>

        <div className="bg-gray-800 rounded-lg p-4 font-mono text-sm">
          <div className="mb-2">
            <span className="text-gray-400">ADMIN_USERNAME=</span>
            <span className="text-green-400">{result.username}</span>
          </div>
          <div className="mb-4">
            <span className="text-gray-400">ADMIN_PASSWORD=</span>
            <span className="text-blue-400 break-all">{result.passwordHash}</span>
          </div>
          <button
            onClick={handleCopyCredentials}
            className={`w-full rounded-md py-2 px-4 font-semibold transition-all duration-200 ${
              copied
                ? "bg-green-600 text-white"
                : "bg-blue-600 hover:bg-blue-700 text-white"
            }`}
          >
            {copied ? "Copied!" : "Copy Credentials"}
          </button>
        </div>

        <div className="bg-gray-800 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-gray-200 mb-2">Next Steps:</h4>
          <ol className="list-decimal list-inside text-sm text-gray-400 space-y-1">
            {result.instructions.map((instruction, index) => (
              <li key={index}>{instruction}</li>
            ))}
          </ol>
        </div>

        <button
          onClick={onSetupComplete}
          className="w-full rounded-md bg-gray-700 hover:bg-gray-600 text-white font-semibold py-2 px-4 transition-all duration-200"
        >
          Back to Login
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="bg-yellow-900/30 border border-yellow-600 rounded-lg p-4 mb-4">
        <h3 className="text-sm font-semibold text-yellow-400 mb-1">
          Initial Admin Setup
        </h3>
        <p className="text-xs text-gray-300">
          No admin account is configured. Create your admin credentials below.
          This can only be done once.
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="mb-4">
          <label
            htmlFor="setupUsername"
            className="block text-sm font-semibold text-gray-200 mb-2"
          >
            Admin Username
          </label>
          <input
            id="setupUsername"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter admin username"
            className="block w-full rounded-md border border-gray-600 bg-gray-900/50
                       px-3 py-2 text-gray-100 placeholder-gray-500 shadow-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            disabled={loading}
            autoComplete="username"
          />
        </div>

        <div className="mb-4">
          <label
            htmlFor="setupPassword"
            className="block text-sm font-semibold text-gray-200 mb-2"
          >
            Password
          </label>
          <input
            id="setupPassword"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            className="block w-full rounded-md border border-gray-600 bg-gray-900/50
                       px-3 py-2 text-gray-100 placeholder-gray-500 shadow-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            disabled={loading}
            autoComplete="new-password"
          />
          <p className="mt-1 text-xs text-gray-400">
            Minimum {MIN_PASSWORD_LENGTH} characters
          </p>
        </div>

        <div className="mb-6">
          <label
            htmlFor="setupConfirmPassword"
            className="block text-sm font-semibold text-gray-200 mb-2"
          >
            Confirm Password
          </label>
          <input
            id="setupConfirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm password"
            className="block w-full rounded-md border border-gray-600 bg-gray-900/50
                       px-3 py-2 text-gray-100 placeholder-gray-500 shadow-sm
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            disabled={loading}
            autoComplete="new-password"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-blue-600 hover:bg-blue-700
                     text-white font-semibold py-2 px-4 shadow-lg
                     transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-400
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Creating Admin..." : "Create Admin Account"}
        </button>

        {error && (
          <p className="mt-4 text-center text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
