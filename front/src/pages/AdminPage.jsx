import { useEffect } from "react";
import AdminDashboard from "../components/admin/AdminDashboard";

export default function AdminPage() {
  useEffect(() => {
    document.title = "Admin Dashboard";
  }, []);

  return (
    <section
      className="min-h-[90vh] flex items-center justify-center p-4 transition-colors duration-300"
    >
      <div className="w-full max-w-6xl mx-auto">
        <div className="bg-[var(--bg-main)] dark:bg-white/[0.02] backdrop-blur-md p-8 rounded-2xl shadow-xl border border-slate-200 dark:border-white/10 transition-colors">
          <h1 className="text-3xl font-bold text-center mb-6 text-slate-900 dark:text-white transition-colors">Admin Dashboard</h1>
          <AdminDashboard />
        </div>
      </div>
    </section>
  );
}
