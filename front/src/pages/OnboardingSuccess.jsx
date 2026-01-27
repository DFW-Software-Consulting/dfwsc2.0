import { useEffect } from 'react';

export default function OnboardingSuccess() {
  useEffect(() => {
    document.title = "Onboarding Complete - DFW Software Consulting";
  }, []);

  return (
    <div className="min-h-[90vh] flex items-center justify-center bg-gradient-to-b from-gray-900 to-gray-800">
      <div className="text-center max-w-2xl mx-auto px-6">
        <div className="w-16 h-16 mx-auto mb-6 flex items-center justify-center rounded-full bg-green-500/20">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-green-400" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-white mb-4">Onboarding Complete</h1>
        <p className="text-gray-200 text-lg mb-6">
          Your Stripe account setup is complete. DFWSC will follow up with next steps shortly.
        </p>
        <p className="text-gray-400">
          If you have questions, reply to the onboarding email or contact our team.
        </p>
      </div>
    </div>
  );
}
