import { useEffect } from 'react';

export default function PaymentCancel() {
  useEffect(() => {
    document.title = "Payment Canceled - DFW Software Consulting";
  }, []);

  return (
    <div className="min-h-[90vh] flex items-center justify-center bg-gradient-to-b from-gray-900 to-gray-800">
      <div className="text-center max-w-2xl mx-auto px-6">
        <div className="w-16 h-16 mx-auto mb-6 flex items-center justify-center rounded-full bg-amber-500/20">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-amber-400" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M18 10A8 8 0 11.001 10 8 8 0 0118 10zM9 6a1 1 0 012 0v4a1 1 0 11-2 0V6zm1 9a1.25 1.25 0 100-2.5A1.25 1.25 0 0010 15z" clipRule="evenodd" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-white mb-4">Payment Canceled</h1>
        <p className="text-gray-200 text-lg mb-6">
          Your payment was canceled. If this was a mistake, you can retry the payment or reach out for help.
        </p>
        <p className="text-gray-400">
          Need assistance? Contact the DFWSC team and we&apos;ll get you squared away.
        </p>
      </div>
    </div>
  );
}
