import { useState, useCallback } from "react";
import logger from "../../utils/logger";

function formatCurrency(amount, currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency ?? "usd",
  }).format(amount / 100);
}

function formatDate(ts) {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function PaymentReports({ clients, groups, showToast, onSessionExpired }) {
  const [reportType, setReportType] = useState("client");
  const [selectedId, setSelectedId] = useState("");
  const [limit, setLimit] = useState("10");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleTypeChange = useCallback((type) => {
    setReportType(type);
    setSelectedId("");
    setResults(null);
  }, []);

  const fetchReport = useCallback(async () => {
    if (!selectedId) return;
    const token = sessionStorage.getItem("adminToken");
    if (!token) { onSessionExpired?.(); return; }

    const params = new URLSearchParams();
    if (reportType === "client") params.set("clientId", selectedId);
    else params.set("groupId", selectedId);
    if (limit) params.set("limit", limit);

    setLoading(true);
    setResults(null);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/reports/payments?${params}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          sessionStorage.removeItem("adminToken");
          onSessionExpired?.();
          return;
        }
        const data = await res.json().catch(() => ({ error: "Failed to fetch report" }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setResults(await res.json());
    } catch (err) {
      logger.error("Error fetching report:", err);
      showToast?.(err.message, "error");
    } finally {
      setLoading(false);
    }
  }, [reportType, selectedId, limit, onSessionExpired, showToast]);

  const items = reportType === "client" ? clients : groups;

  return (
    <div>
      <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
        <h4 className="text-md font-semibold text-white mb-4">Payment Reports</h4>

        {/* Report type toggle */}
        <div className="flex gap-6 mb-4">
          {[
            { value: "client", label: "By Client" },
            { value: "group", label: "By Group" },
          ].map(({ value, label }) => (
            <label
              key={value}
              className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer"
            >
              <input
                type="radio"
                name="reportType"
                value={value}
                checked={reportType === value}
                onChange={() => handleTypeChange(value)}
                className="accent-blue-500"
              />
              {label}
            </label>
          ))}
        </div>

        {/* Controls */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <div className="md:col-span-2">
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— Select {reportType} —</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <select
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {["10", "25", "50", "100"].map((v) => (
                <option key={v} value={v}>{v} results</option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={fetchReport}
          disabled={loading || !selectedId}
          className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium
                     transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Loading..." : "Run Report"}
        </button>
      </div>

      {/* Results */}
      {results && (
        <div>
          {results.data?.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-6">
              No payments found for this {reportType}.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-700">
                  <thead>
                    <tr>
                      {["Date", "Payment ID", "Amount", "Platform Fee", "Status", ...(reportType === "group" ? ["Client"] : [])].map(
                        (h) => (
                          <th
                            key={h}
                            className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider"
                          >
                            {h}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {results.data?.map((pi) => (
                      <tr key={pi.id} className="hover:bg-gray-700/50">
                        <td className="px-3 py-2 text-sm text-gray-200 whitespace-nowrap">
                          {formatDate(pi.created)}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-400 font-mono whitespace-nowrap">
                          {pi.id}
                        </td>
                        <td className="px-3 py-2 text-sm text-gray-200 whitespace-nowrap">
                          {formatCurrency(pi.amount, pi.currency)}
                        </td>
                        <td className="px-3 py-2 text-sm text-gray-200 whitespace-nowrap">
                          {pi.application_fee_amount != null
                            ? formatCurrency(pi.application_fee_amount, pi.currency)
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-sm whitespace-nowrap">
                          <span
                            className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                              pi.status === "succeeded"
                                ? "bg-green-800 text-green-200"
                                : pi.status === "canceled"
                                ? "bg-red-800 text-red-200"
                                : "bg-yellow-800 text-yellow-200"
                            }`}
                          >
                            {pi.status}
                          </span>
                        </td>
                        {reportType === "group" && (
                          <td className="px-3 py-2 text-sm text-gray-200 whitespace-nowrap">
                            {pi.clientId ?? "—"}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {results.hasMore && (
                <p className="text-xs text-gray-400 mt-3 text-center">
                  More results available — increase the limit to see them.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
