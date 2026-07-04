import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { confirmBootstrap } from "../../api/auth";
import { useAuth } from "../../contexts/AuthContext";
import { validatePassword } from "../../utils/validation";
import Button from "./shared/Button";
import FormInput from "./shared/FormInput";

// Must match MIN_ADMIN_PASSWORD_LENGTH in backend/src/routes/auth.ts
const MIN_PASSWORD_LENGTH = 12;

export default function AdminSetup({
  onSetupComplete,
  showToast,
  token,
  isBootstrapPending = false,
}) {
  const { logout } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const confirmMutation = useMutation({
    mutationFn: ({ body, token }) => confirmBootstrap(body, token),
    onSuccess: () => {
      showToast?.("Admin credentials confirmed successfully!", "success");
      onSetupComplete?.();
    },
    onError: (err) => {
      setError(err.message || "Confirmation failed");
      showToast?.(err.message || "Confirmation failed", "error");
      if (err.status === 401) {
        logout();
      }
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

  const handleConfirmSubmit = useCallback(
    (e) => {
      e.preventDefault();
      const validationError = validateForm();
      if (validationError) {
        setError(validationError);
        return;
      }
      setError("");
      confirmMutation.mutate({
        body: { username: username.trim(), password },
        token,
      });
    },
    [username, password, token, validateForm, confirmMutation]
  );

  return (
    <div>
      <div className="bg-yellow-900/30 border border-yellow-600 rounded-lg p-4 mb-4">
        <h3 className="text-sm font-semibold text-yellow-400 mb-1">
          {isBootstrapPending ? "Confirm Bootstrap Admin" : "First-Run Setup"}
        </h3>
        <p className="text-xs text-gray-300">
          {isBootstrapPending
            ? "An admin account exists but requires confirmation. Set or confirm your admin credentials below."
            : "No admin account is configured yet."}
        </p>
      </div>

      {!isBootstrapPending ? (
        // Static instructions — the initial admin is bootstrapped from
        // environment variables, not created through the API.
        <div className="bg-gray-800 rounded-lg p-4 space-y-3">
          <p className="text-sm text-gray-300">
            Set the following environment variables on the API server and restart it:
          </p>
          <div className="font-mono text-sm bg-gray-900 rounded-md p-3 space-y-1">
            <div>
              <span className="text-gray-400">ADMIN_USERNAME=</span>
              <span className="text-green-400">your-admin-username</span>
            </div>
            <div>
              <span className="text-gray-400">ADMIN_PASSWORD=</span>
              <span className="text-blue-400">a-strong-password</span>
            </div>
          </div>
          <p className="text-xs text-gray-400">
            The password must be at least {MIN_PASSWORD_LENGTH} characters long.
          </p>
          <p className="text-sm text-gray-300">
            After restarting the API, log in with those credentials and confirm them to finish
            setup.
          </p>
        </div>
      ) : (
        // Admin confirmation form
        <form onSubmit={handleConfirmSubmit}>
          <FormInput
            id="setupUsername"
            label="Admin Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter admin username"
            disabled={confirmMutation.isPending}
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
            disabled={confirmMutation.isPending}
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
            disabled={confirmMutation.isPending}
            autoComplete="new-password"
            wrapperClassName="mb-6"
          />

          <Button
            type="submit"
            disabled={confirmMutation.isPending}
            isLoading={confirmMutation.isPending}
            className="w-full shadow-lg focus:ring-2 focus:ring-blue-400"
          >
            {confirmMutation.isPending ? "Confirming Admin..." : "Confirm Admin Account"}
          </Button>

          {error && (
            <p className="mt-4 text-center text-sm text-red-400" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
