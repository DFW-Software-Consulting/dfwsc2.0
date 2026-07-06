import { useEffect } from "react";
import { Link } from "react-router-dom";

export default function NotFound() {
  useEffect(() => {
    document.title = "Page Not Found";
  }, []);

  return (
    <section className="min-h-[90vh] flex items-center justify-center p-4 transition-colors duration-300">
      <div className="w-full max-w-xl mx-auto">
        <div className="bg-[var(--bg-main)] dark:bg-white/[0.02] backdrop-blur-md p-8 rounded-2xl shadow-xl border border-slate-200 dark:border-white/10 text-center transition-colors">
          <p className="text-sm font-bold uppercase tracking-widest text-brand-600 dark:text-brand-400 transition-colors">
            404
          </p>
          <h1 className="mt-4 text-3xl font-bold text-center mb-4 text-slate-900 dark:text-white transition-colors">
            Page not found
          </h1>
          <p className="text-center text-slate-600 dark:text-gray-300 mb-8 transition-colors">
            The page you&apos;re looking for doesn&apos;t exist or may have been moved.
          </p>

          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-full bg-brand-500 hover:bg-brand-600
                       text-white font-semibold py-2.5 px-6 shadow-glow
                       transition-all duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </section>
  );
}
