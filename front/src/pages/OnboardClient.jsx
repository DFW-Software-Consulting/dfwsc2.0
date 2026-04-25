import { useCallback, useEffect, useState } from "react";
import { useInitiateOnboarding } from "../hooks/useOnboarding";
import logger from "../utils/logger";

export default function OnboardClient() {
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const { mutate, isPending } = useInitiateOnboarding();

  useEffect(() => {
    document.title = "Client Stripe Onboarding";
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get("token");
    if (tokenFromUrl) setToken(tokenFromUrl);
  }, []);

  const handleSubmit = useCallback(() => {
    if (!token) {
      setMessage("Please enter your onboarding token.");
      return;
    }
    setMessage("Verifying token and redirecting...");
    mutate(token, {
      onSuccess: (data) => {
        if (!data?.url) {
          setMessage("Error: API did not return a 'url' field.");
          return;
        }
        setMessage("Redirecting to Stripe...");
        window.location.href = data.url;
      },
      onError: (err) => {
        logger.error("Onboarding error:", err);
        setMessage(`Error: ${err.message}`);
      },
    });
  }, [token, mutate]);

  const isError = message.startsWith("Error");

  return (
    <section
      className="min-h-[90vh] flex items-center justify-center p-4 transition-colors duration-300"
    >
      <div className="w-full max-w-xl mx-auto">
        <div className="bg-[var(--bg-main)] dark:bg-white/[0.02] backdrop-blur-md p-8 rounded-2xl shadow-xl border border-slate-200 dark:border-white/10 transition-colors">
          <h1 className="text-3xl font-bold text-center mb-4 text-slate-900 dark:text-white transition-colors">Stripe Account Setup</h1>

          <p className="text-center text-slate-600 dark:text-gray-300 mb-8 transition-colors">
            Please enter the onboarding token provided by{" "}
            <span className="text-brand-600 dark:text-brand-400 font-semibold transition-colors">DFW Software Consulting</span> to set up
            your Stripe account.
          </p>

          <div className="mb-6">
            <label
              htmlFor="onboardingToken"
              className="block text-sm font-semibold text-slate-700 dark:text-gray-200 mb-2 transition-colors"
            >
              Onboarding Token
            </label>
            <input
              id="onboardingToken"
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enter your token"
              className="block w-full rounded-md border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-900/50
                         px-3 py-2 text-slate-900 dark:text-gray-100 placeholder-slate-400 dark:placeholder-gray-500 shadow-sm
                         focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-blue-500 transition-all"
            />
          </div>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={isPending}
            className="mt-6 w-full rounded-full bg-brand-500 hover:bg-brand-600
                       text-white font-semibold py-2.5 px-4 shadow-glow
                       transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand-400
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? "Processing..." : "Continue to Stripe Setup"}
          </button>

          {message && (
            <p className={`mt-4 text-center text-sm font-medium ${isError ? "text-red-500 dark:text-red-400" : "text-brand-600 dark:text-brand-400"} transition-colors`}>
              {message}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
