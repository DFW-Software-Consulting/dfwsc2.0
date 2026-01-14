import { useState, useCallback } from "react";

const MIN_PASSWORD_LENGTH = 8;

export default function AdminLogin({ onLoginSuccess, showToast }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const validateForm = useCallback(() => {
    if (!username.trim()) {
      return "Username is required";
    }
    if (!password) {
      return "Password is required";
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    return null;
  }, [username, password]);

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
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/v1/auth/login`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              username: username.trim(),
              password,
            }),
          }
        );

        if (!res.ok) {
          const errorData = await res
            .json()
            .catch(() => ({ error: "Invalid credentials" }));
          throw new Error(errorData.error || "Login failed");
        }

        const data = await res.json();
        if (data.token) {
          sessionStorage.setItem("adminToken", data.token);
          onLoginSuccess(data.token);
          setUsername("");
          setPassword("");
        } else {
          throw new Error("Login response did not contain token");
        }
      } catch (err) {
        console.error("Admin login error:", err);
        setError(err.message || "Login failed");
        showToast?.(err.message || "Login failed", "error");
      } finally {
        setLoading(false);
      }
    },
    [username, password, validateForm, onLoginSuccess, showToast]
  );

  return (
    <form onSubmit={handleSubmit}>
      <div className="mb-4">
        <label
          htmlFor="adminUsername"
          className="block text-sm font-semibold text-gray-200 mb-2"
        >
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
          disabled={loading}
          autoComplete="username"
        />
      </div>

      <div className="mb-6">
        <label
          htmlFor="adminPassword"
          className="block text-sm font-semibold text-gray-200 mb-2"
        >
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
          disabled={loading}
          autoComplete="current-password"
        />
        <p className="mt-1 text-xs text-gray-400">
          Minimum {MIN_PASSWORD_LENGTH} characters
        </p>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-green-600 hover:bg-green-700
                   text-white font-semibold py-2 px-4 shadow-lg
                   transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-green-400
                   disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? "Logging in..." : "Log In"}
      </button>

      {error && (
        <p className="mt-4 text-center text-sm text-red-400" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
