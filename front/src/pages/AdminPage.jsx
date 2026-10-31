import AdminDashboard from "../components/admin/AdminDashboard";
import { usePageTitle } from "../hooks/usePageTitle";

export default function AdminPage() {
  usePageTitle("Admin");

  return (
    <section className="min-h-[90vh] flex items-center justify-center p-4 transition-colors duration-300">
      <div className="w-full max-w-6xl mx-auto">
        <div className="bg-card p-8 rounded-2xl shadow-xl border border-line transition-colors">
          <h1 className="text-3xl font-bold text-center mb-6 text-fg transition-colors">
            Admin Dashboard
          </h1>
          <AdminDashboard />
        </div>
      </div>
    </section>
  );
}
