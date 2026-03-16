import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { login } from "../../api/auth";
import { useAuth } from "../../contexts/AuthContext";
import { validatePassword } from "../../utils/validation";
import Button from "./shared/Button";
import FormInput from "./shared/FormInput";

const MIN_PASSWORD_LENGTH = 8;

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
      setError(err.message || "Login failed");
      showToast?.(err.message || "Login failed", "error");
    },
  });

  const validateForm = useCallback(() => {
    if (!username.trim()) return "Username is required";
    const pwErr = validatePassword(password, MIN_PASSWORD_LENGTH);
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
      <FormInput
        id="adminUsername"
        label="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="Enter admin username"
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
        placeholder="Enter admin password"
        disabled={loginMutation.isPending}
        autoComplete="current-password"
        helper={`Minimum ${MIN_PASSWORD_LENGTH} characters`}
        wrapperClassName="mb-6"
      />

      <Button
        type="submit"
        variant="success"
        disabled={loginMutation.isPending}
        isLoading={loginMutation.isPending}
        className="w-full shadow-lg focus:ring-2 focus:ring-green-400"
      >
        {loginMutation.isPending ? "Logging in..." : "Log In"}
      </Button>

      {error && (
        <p className="mt-4 text-center text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
