import { useCallback, useEffect, useState } from "react";
import { useRequestApiKeyRegeneration } from "../hooks/useApiKey";
import logger from "../utils/logger";

export default function RequestApiKeyRegeneration() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const { mutate, isPending } = useRequestApiKeyRegeneration();

  useEffect(() => {
    document.title = "Regenerate API Key";
  }, []);

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      if (!email.trim()) {
        setError("Please enter your email address.");
        return;
      }
      setError("");
      mutate(email.trim(), {
        onSuccess: () => {
          setSubmitted(true);
        },
        onError: (err) => {
          logger.error("Regeneration request error:", err);
          setSubmitted(true);
        },
      });
    },
    [email, mutate]
  );

  return (
    <section className="min-h-[90vh] flex items-center justify-center p-4 transition-colors duration-300">
      <div className="w-full max-w-xl mx-auto">
        <div className="bg-[var(--bg-main)] dark:bg-white/[0.02] backdrop-blur-md p-8 rounded-2xl shadow-xl border border-slate-200 dark:border-white/10 transition-colors">
          <h1 className="text-3xl font-bold text-center mb-4 text-slate-900 dark:text-white transition-colors">
            Regenerate API Key
          </h1>

          {!submitted ? (
            <>
              <p className="text-center text-slate-600 dark:text-gray-300 mb-8 transition-colors">
                Enter your email address and we will send you a link to regenerate your API key.
              </p>

              <form onSubmit={handleSubmit}>
                <div className="mb-6">
                  <label
                    htmlFor="email"
                    className="block text-sm font-semibold text-slate-700 dark:text-gray-200 mb-2 transition-colors"
                  >
                    Email Address
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="block w-full rounded-md border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-900/50
                               px-3 py-2 text-slate-900 dark:text-gray-100 placeholder-slate-400 dark:placeholder-gray-500 shadow-sm
                               focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-blue-500 transition-all"
                  />
                </div>

                {error && (
                  <p className="mb-4 text-center text-sm font-medium text-red-500 dark:text-red-400 transition-colors">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={isPending}
                  className="w-full rounded-full bg-brand-500 hover:bg-brand-600
                             text-white font-semibold py-2.5 px-4 shadow-glow
                             transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand-400
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isPending ? "Sending..." : "Send Regeneration Link"}
                </button>
              </form>
            </>
          ) : (
            <div className="text-center">
              <p className="text-slate-600 dark:text-gray-300 mb-4 transition-colors">
                If an account with that email exists, a regeneration link has been sent.
              </p>
              <p className="text-sm text-slate-500 dark:text-gray-400 transition-colors">
                Check your inbox and click the link to generate a new API key. The link expires in
                15 minutes.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
