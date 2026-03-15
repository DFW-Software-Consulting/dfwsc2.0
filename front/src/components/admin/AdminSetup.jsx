import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { setup } from "../../api/auth";
import logger from "../../utils/logger";
import { validatePassword } from "../../utils/validation";
import Button from "./shared/Button";
import FormInput from "./shared/FormInput";

const MIN_PASSWORD_LENGTH = 8;

export default function AdminSetup({ onSetupComplete, showToast, setupToken }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupTokenValue, setSetupTokenValue] = useState(setupToken || "");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  const setupMutation = useMutation({
    mutationFn: ({ body, token }) => setup(body, token),
    onSuccess: (data) => {
      setResult(data);
      showToast?.("Admin credentials generated successfully!", "success");
    },
    onError: (err) => {
      setError(err.message || "Setup failed");
      showToast?.(err.message || "Setup failed", "error");
    },
  });

  const validateForm = useCallback(() => {
    if (!username.trim()) return "Username is required";
    if (username.trim().length < 3) return "Username must be at least 3 characters";
    const pwErr = validatePassword(password, MIN_PASSWORD_LENGTH);
    if (pwErr) return pwErr;
    if (password !== confirmPassword) return "Passwords do not match";
    return null;
  }, [username, password, confirmPassword]);

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      const validationError = validateForm();
      if (validationError) {
        setError(validationError);
        return;
      }
      setError("");
      setupMutation.mutate({
        body: { username: username.trim(), password },
        token: setupTokenValue.trim() || undefined,
      });
    },
    [username, password, setupTokenValue, validateForm, setupMutation]
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
          <h3 className="text-lg font-semibold text-green-400 mb-2">Admin Credentials Generated</h3>
          <p className="text-sm text-gray-300 mb-4">
            Copy these credentials and add them to your environment configuration. This setup can
            only be done once.
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
            type="button"
            onClick={handleCopyCredentials}
            className={`w-full rounded-md py-2 px-4 font-semibold transition-all duration-200 ${
              copied ? "bg-green-600 text-white" : "bg-blue-600 hover:bg-blue-700 text-white"
            }`}
          >
            {copied ? "Copied!" : "Copy Credentials"}
          </button>
        </div>

        <div className="bg-gray-800 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-gray-200 mb-2">Next Steps:</h4>
          <ol className="list-decimal list-inside text-sm text-gray-400 space-y-1">
            {result.instructions.map((instruction, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static list
              <li key={index}>{instruction}</li>
            ))}
          </ol>
        </div>

        <button
          type="button"
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
        <h3 className="text-sm font-semibold text-yellow-400 mb-1">Initial Admin Setup</h3>
        <p className="text-xs text-gray-300">
          No admin account is configured. Create your admin credentials below. This can only be done
          once.
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <FormInput
          id="setupToken"
          label="Setup Token (optional)"
          value={setupTokenValue}
          onChange={(e) => setSetupTokenValue(e.target.value)}
          placeholder="Enter setup token if required"
          disabled={setupMutation.isPending}
          autoComplete="one-time-code"
          helper="Required only when ADMIN_SETUP_TOKEN is enabled on the server."
          wrapperClassName="mb-4"
        />

        <FormInput
          id="setupUsername"
          label="Admin Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Enter admin username"
          disabled={setupMutation.isPending}
          autoComplete="username"
          wrapperClassName="mb-4"
        />

        <FormInput
          id="setupPassword"
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter password"
          disabled={setupMutation.isPending}
          autoComplete="new-password"
          helper={`Minimum ${MIN_PASSWORD_LENGTH} characters`}
          wrapperClassName="mb-4"
        />

        <FormInput
          id="setupConfirmPassword"
          label="Confirm Password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Confirm password"
          disabled={setupMutation.isPending}
          autoComplete="new-password"
          wrapperClassName="mb-6"
        />

        <Button
          type="submit"
          disabled={setupMutation.isPending}
          isLoading={setupMutation.isPending}
          className="w-full shadow-lg focus:ring-2 focus:ring-blue-400"
        >
          {setupMutation.isPending ? "Creating Admin..." : "Create Admin Account"}
        </Button>

        {error && (
          <p className="mt-4 text-center text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
