import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { login } from "../../api/auth";
import { useAuth } from "../../contexts/AuthContext";
import { validatePassword } from "../../utils/validation";
import Button from "./shared/Button";
import FormInput from "./shared/FormInput";

const NOT_AUTHORIZED_MESSAGE = "This Nextcloud account isn't authorized for the admin panel";
const UNAVAILABLE_MESSAGE = "Admin login is unavailable";

// The API's own message is shown when it sent one; the status decides the wording otherwise.
function loginErrorMessage(err) {
  if (err?.status === 403) return err.message || NOT_AUTHORIZED_MESSAGE;
  if (err?.status === 503) return err.message || UNAVAILABLE_MESSAGE;
  return err?.message || "Login failed";
}

export default function AdminLogin({ showToast }) {
  const { login: authLogin } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const loginMutation = useMutation({
    mutationFn: (vars) => login(vars),
    onSuccess: (data) => {
      authLogin(data.token);
      setUsername("");
      setPassword("");
    },
    onError: (err) => {
      const message = loginErrorMessage(err);
      setError(message);
      showToast?.(message, "error");
    },
  });

  const validateForm = useCallback(() => {
    if (!username.trim()) return "Username is required";
    const pwErr = validatePassword(password, 1);
    if (pwErr) return pwErr;
    return null;
  }, [username, password]);

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      const validationError = validateForm();
      if (validationError) {
        setError(validationError);
        return;
      }
      setError("");
      loginMutation.mutate({ username: username.trim(), password });
    },
    [username, password, validateForm, loginMutation]
  );

  return (
    <form onSubmit={handleSubmit}>
      <p className="mb-1 text-sm font-medium text-fg">Sign in with your Nextcloud account</p>
      <p className="mb-4 text-xs text-fg-muted">
        Accounts with two-factor login need a Nextcloud app password
      </p>

      <FormInput
        id="adminUsername"
        label="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="Nextcloud username"
        disabled={loginMutation.isPending}
        autoComplete="username"
        wrapperClassName="mb-4"
      />

      <FormInput
        id="adminPassword"
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Nextcloud password or app password"
        disabled={loginMutation.isPending}
        autoComplete="current-password"
        wrapperClassName="mb-6"
      />

      <Button
        type="submit"
        variant="primary"
        disabled={loginMutation.isPending}
        isLoading={loginMutation.isPending}
        className="w-full shadow-lg"
      >
        {loginMutation.isPending ? "Logging in..." : "Log In"}
      </Button>

      {error && (
        <p className="mt-4 text-center text-sm text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
