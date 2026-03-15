import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { login } from "../../api/auth";
import { useAuth } from "../../contexts/AuthContext";

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
    if (!password) return "Password is required";
    if (password.length < MIN_PASSWORD_LENGTH)
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
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
      <div className="mb-4">
        <label htmlFor="adminUsername" className="block text-sm font-semibold text-gray-200 mb-2">
          Username
        </label>
        <input
          id="adminUsername"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Enter admin username"
          className="block w-full rounded-md border border-gray-600 bg-gray-900/50
                     px-3 py-2 text-gray-100 placeholder-gray-500 shadow-sm
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          disabled={loginMutation.isPending}
          autoComplete="username"
        />
      </div>

      <div className="mb-6">
        <label htmlFor="adminPassword" className="block text-sm font-semibold text-gray-200 mb-2">
          Password
        </label>
        <input
          id="adminPassword"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter admin password"
          className="block w-full rounded-md border border-gray-600 bg-gray-900/50
                     px-3 py-2 text-gray-100 placeholder-gray-500 shadow-sm
                     focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          disabled={loginMutation.isPending}
          autoComplete="current-password"
        />
        <p className="mt-1 text-xs text-gray-400">Minimum {MIN_PASSWORD_LENGTH} characters</p>
      </div>

      <button
        type="submit"
        disabled={loginMutation.isPending}
        className="w-full rounded-md bg-green-600 hover:bg-green-700
                   text-white font-semibold py-2 px-4 shadow-lg
                   transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-green-400
                   disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loginMutation.isPending ? "Logging in..." : "Log In"}
      </button>

      {error && (
        <p className="mt-4 text-center text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
