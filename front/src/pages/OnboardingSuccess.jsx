import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

export default function OnboardingSuccess() {
  const [searchParams] = useSearchParams();
  const expired = searchParams.get("status") === "expired";

  useEffect(() => {
    document.title = expired
      ? "Setup Session Timed Out - DFW Software Consulting"
      : "Onboarding Complete - DFW Software Consulting";
  }, [expired]);

  if (expired) {
    return (
      <div className="min-h-[90vh] flex items-center justify-center transition-colors duration-300">
        <div className="text-center max-w-2xl mx-auto px-6">
          <div className="w-16 h-16 mx-auto mb-6 flex items-center justify-center rounded-full bg-slate-500/10 border border-slate-500/20">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-10 w-10 text-slate-500"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.5 2.5a1 1 0 001.414-1.414L11 9.586V6z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-4 transition-colors">
            Your setup session timed out
          </h1>
          <p className="text-slate-600 dark:text-gray-200 text-lg mb-6 transition-colors">
            If you finished Stripe's form, your details were saved and your account will be
            activated automatically. You don't need to do anything else. If you hadn't finished,
            your onboarding link has expired too, so reply to the onboarding email and we'll send
            you a new one.
          </p>
          <p className="text-slate-500 dark:text-gray-400 transition-colors">
            If you have questions, reply to the onboarding email or contact our team.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[90vh] flex items-center justify-center transition-colors duration-300">
      <div className="text-center max-w-2xl mx-auto px-6">
        <div className="w-16 h-16 mx-auto mb-6 flex items-center justify-center rounded-full bg-green-500/10 border border-green-500/20">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-10 w-10 text-green-500"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clipRule="evenodd"
            />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-4 transition-colors">
          Onboarding Complete
        </h1>
        <p className="text-slate-600 dark:text-gray-200 text-lg mb-6 transition-colors">
          Your Stripe account setup is complete. DFWSC will follow up with next steps shortly.
        </p>
        <p className="text-slate-500 dark:text-gray-400 transition-colors">
          If you have questions, reply to the onboarding email or contact our team.
        </p>
      </div>
    </div>
  );
}
