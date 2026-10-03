import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

// Non-success outcomes of the Stripe return redirect (`?status=<key>`). Any other
// value (completed, missing, unknown) falls through to the success content.
const STATES = {
  expired: {
    title: "Setup Session Timed Out - DFW Software Consulting",
    heading: "Your setup session timed out",
    body: "If you finished Stripe's form, your details were saved and your account will be activated automatically. You don't need to do anything else. If you hadn't finished, your onboarding link has expired too, so reply to the onboarding email and we'll send you a new one.",
    tone: "slate",
  },
  pending: {
    title: "Stripe Setup Not Finished - DFW Software Consulting",
    heading: "Your Stripe setup isn't finished yet",
    body: "If you completed Stripe's form, Stripe is still verifying your details and your account will be activated automatically. If you left the form early, reopen the onboarding link from your email to continue.",
    tone: "slate",
  },
  error: {
    title: "Setup Not Confirmed - DFW Software Consulting",
    heading: "We couldn't confirm your setup just now",
    body: "We had trouble checking your account with Stripe. Your details are saved, and your account will be activated automatically once Stripe confirms it. If you don't hear from us, reply to the onboarding email.",
    tone: "amber",
  },
};

const TONES = {
  slate: {
    badge: "bg-slate-500/10 border border-slate-500/20",
    icon: "text-slate-500",
  },
  amber: {
    badge: "bg-amber-500/10 border border-amber-500/20",
    icon: "text-amber-500",
  },
};

export default function OnboardingSuccess() {
  const [searchParams] = useSearchParams();
  const status = searchParams.get("status");
  const state = Object.hasOwn(STATES, status) ? STATES[status] : null;

  useEffect(() => {
    document.title = state ? state.title : "Onboarding Complete - DFW Software Consulting";
  }, [state]);

  if (state) {
    const tone = TONES[state.tone];
    return (
      <div className="min-h-[90vh] flex items-center justify-center transition-colors duration-300">
        <div className="text-center max-w-2xl mx-auto px-6">
          <div
            className={`w-16 h-16 mx-auto mb-6 flex items-center justify-center rounded-full ${tone.badge}`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-10 w-10 ${tone.icon}`}
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
            {state.heading}
          </h1>
          <p className="text-slate-600 dark:text-gray-200 text-lg mb-6 transition-colors">
            {state.body}
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
