import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useRegenerateApiKey } from "../hooks/useApiKey";
import logger from "../utils/logger";

export default function RegenerateApiKey() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => {
    const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
    return hashParams.get("token") || "";
  });
  const [apiKey, setApiKey] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const { mutate, isPending } = useRegenerateApiKey();

  useEffect(() => {
    document.title = "Regenerate API Key";
    if (location.search || location.hash) {
      navigate(location.pathname, { replace: true });
    }
  }, [location.hash, location.pathname, location.search, navigate]);

  const handleRegenerate = useCallback(() => {
    if (!token) {
      setError("No regeneration token found. Please use the link from your email.");
      return;
    }
    setError("");
    mutate(token, {
      onSuccess: (data) => {
        if (!data?.apiKey) {
          setError("Error: API did not return a key.");
          return;
        }
        setApiKey(data.apiKey);
      },
      onError: (err) => {
        logger.error("Regeneration error:", err);
        setError(err.message);
      },
    });
  }, [token, mutate]);

  const handleCopy = useCallback(async () => {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = apiKey;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [apiKey]);

  return (
    <section className="min-h-[90vh] flex items-center justify-center p-4 transition-colors duration-300">
      <div className="w-full max-w-xl mx-auto">
        <div className="bg-[var(--bg-main)] dark:bg-white/[0.02] backdrop-blur-md p-8 rounded-2xl shadow-xl border border-slate-200 dark:border-white/10 transition-colors">
          <h1 className="text-3xl font-bold text-center mb-4 text-slate-900 dark:text-white transition-colors">
            Regenerate API Key
          </h1>

          {!apiKey && !error && (
            <>
              <p className="text-center text-slate-600 dark:text-gray-300 mb-8 transition-colors">
                Click the button below to generate a new API key. Your current key will be
                invalidated immediately.
              </p>

              <button
                type="button"
                onClick={handleRegenerate}
                disabled={isPending || !token}
                className="mt-6 w-full rounded-full bg-brand-500 hover:bg-brand-600
                           text-white font-semibold py-2.5 px-4 shadow-glow
                           transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand-400
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isPending ? "Generating..." : "Regenerate API Key"}
              </button>

              {!token && (
                <p className="mt-4 text-center text-sm font-medium text-red-500 dark:text-red-400 transition-colors">
                  No regeneration token found. Please use the link from your email.
                </p>
              )}
            </>
          )}

          {apiKey && (
            <div className="mt-6">
              <div className="bg-gray-900 dark:bg-gray-800 rounded-lg p-4 mb-4">
                <code className="block text-sm text-green-400 font-mono break-all select-all">
                  {apiKey}
                </code>
              </div>

              <button
                type="button"
                onClick={handleCopy}
                className="w-full rounded-full bg-brand-500 hover:bg-brand-600
                           text-white font-semibold py-2.5 px-4 shadow-glow
                           transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                {copied ? "Copied!" : "Copy to Clipboard"}
              </button>

              <div className="mt-4 p-3 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700">
                <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-300 text-center">
                  Save this key now — it will not be shown again.
                </p>
                <p className="text-xs text-yellow-700 dark:text-yellow-400 text-center mt-1">
                  Store it securely in your application's environment variables or a secrets
                  manager.
                </p>
              </div>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="mt-4 text-center text-sm font-medium text-red-500 dark:text-red-400 transition-colors"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
