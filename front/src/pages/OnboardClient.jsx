import { useState, useEffect } from "react";

export default function OnboardClient() {
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = "Client Stripe Onboarding";
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get("token");
    if (tokenFromUrl) setToken(tokenFromUrl);
  }, []);

  const handleSubmit = async () => {
    if (!token) {
      setMessage("Please enter your onboarding token.");
      return;
    }
    setLoading(true);
    setMessage("Verifying token and redirecting...");

    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/v1/onboard-client?token=${encodeURIComponent(token)}`,
        { headers: { Accept: "application/json" } }
      );

      const contentType = res.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");

      if (!res.ok) {
        // Try to read error details
        const errPayload = isJson ? await res.json().catch(() => ({})) : await res.text();
        const errText =
          typeof errPayload === "string"
            ? errPayload.slice(0, 200) // show a snippet if it's HTML
            : errPayload.error || errPayload.message || `HTTP ${res.status}`;
        throw new Error(errText);
      }

      // OK, but make sure it's JSON
      if (!isJson) {
        const text = await res.text();
        throw new Error(`Expected JSON but got: ${text.slice(0, 200)}…`);
      }

      const data = await res.json();
      if (!data?.url) {
        throw new Error("API did not return a 'url' field.");
      }

      setMessage("Redirecting to Stripe...");
      window.location.href = data.url;
    } catch (err) {
      console.error("Onboarding error:", err);
      setMessage(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const isError = message.startsWith("Error");

  return (
    <section
      className="min-h-[90vh] flex items-center justify-center 
                 bg-gradient-to-b from-gray-900 via-gray-800 to-gray-900 
                 text-gray-100"
    >
      <div className="mx-auto w-full max-w-md px-6 sm:px-8">
        <div className="bg-gray-800/60 backdrop-blur-md p-8 rounded-2xl shadow-xl border border-gray-700">
          <h1 className="text-3xl font-bold text-center mb-4 text-white">
            Stripe Account Setup
          </h1>

          <p className="text-center text-gray-300 mb-8">
            Please enter the onboarding token provided by{" "}
            <span className="text-blue-400 font-semibold">
              DFW Software Consulting
            </span>{" "}
            to set up your Stripe account.
          </p>

          <div className="mb-6">
            <label
              htmlFor="onboardingToken"
              className="block text-sm font-semibold text-gray-200 mb-2"
            >
              Onboarding Token
            </label>
            <input
              id="onboardingToken"
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enter your token"
              className="block w-full rounded-md border border-gray-600 bg-gray-900/50 
                         px-3 py-2 text-gray-100 placeholder-gray-500 shadow-sm 
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <button
            onClick={handleSubmit}
            disabled={loading}
            className="mt-6 w-full rounded-md bg-blue-600 hover:bg-blue-700 
                       text-white font-semibold py-2 px-4 shadow-lg 
                       transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-400
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Processing..." : "Continue to Stripe Setup"}
          </button>

          {message && (
            <p
              className={`mt-4 text-center text-sm ${
                isError ? "text-red-400" : "text-blue-400"
              }`}
            >
              {message}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
