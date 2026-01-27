import { useEffect } from "react";
import AdminDashboard from "../components/admin/AdminDashboard";

export default function AdminPage() {
  useEffect(() => {
    document.title = "Admin Dashboard";
  }, []);

  return (
    <section
      className="min-h-[90vh] flex items-center justify-center
                 bg-gradient-to-b from-gray-900 via-gray-800 to-gray-900
                 text-gray-100 p-4"
    >
      <div className="w-full max-w-2xl mx-auto">
        <div className="bg-gray-800/60 backdrop-blur-md p-8 rounded-2xl shadow-xl border border-gray-700">
          <h1 className="text-3xl font-bold text-center mb-6 text-white">
            Admin Dashboard
          </h1>
          <AdminDashboard />
        </div>
      </div>
    </section>
  );
}
