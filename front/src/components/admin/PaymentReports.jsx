import { useCallback, useEffect, useState } from "react";
import { useClients } from "../../hooks/useClients";
import { useGroups } from "../../hooks/useGroups";
import { usePaymentReport } from "../../hooks/usePaymentReports";
import AdminTable from "./shared/AdminTable";
import StatusBadge from "./shared/StatusBadge";

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

export default function PaymentReports({ workspace = "client_portal" }) {
  const isDfwscMode = workspace === "dfwsc_services";
  const { data: clients = [] } = useClients({ workspace });
  const { data: groups = [] } = useGroups(workspace);

  const [reportType, setReportType] = useState("client");
  const [selectedId, setSelectedId] = useState("");
  const [limit, setLimit] = useState("10");
  const [reportEnabled, setReportEnabled] = useState(false);

  const params = selectedId
    ? {
        ...(reportType === "client" ? { clientId: selectedId } : { groupId: selectedId }),
        workspace,
        limit,
      }
    : {};

  const {
    data: results,
    isFetching,
    refetch,
  } = usePaymentReport(params, {
    enabled: reportEnabled && !!selectedId,
  });

  const handleTypeChange = useCallback((type) => {
    setReportType(type);
    setSelectedId("");
    setReportEnabled(false);
  }, []);

  const handleRunReport = useCallback(() => {
    if (!selectedId) return;
    if (reportEnabled) {
      refetch();
    } else {
      setReportEnabled(true);
    }
  }, [selectedId, reportEnabled, refetch]);

  const items = reportType === "client" ? clients : groups;
  const reportTypes = isDfwscMode
    ? [{ value: "client", label: "By Client" }]
    : [
        { value: "client", label: "By Client" },
        { value: "group", label: "By Group" },
      ];

  useEffect(() => {
    if (isDfwscMode && reportType !== "client") {
      setReportType("client");
      setSelectedId("");
      setReportEnabled(false);
    }
  }, [isDfwscMode, reportType]);

  const resultColumns = [
    {
      header: "Date",
      render: (pi) => formatDate(pi.created),
    },
    {
      header: "Payment ID",
      tdClassName: "font-mono text-gray-400 text-xs",
      render: (pi) => pi.id,
    },
    {
      header: "Amount",
      render: (pi) => formatCurrency(pi.amount, pi.currency),
    },
    {
      header: "Platform Fee",
      render: (pi) =>
        pi.application_fee_amount != null
          ? formatCurrency(pi.application_fee_amount, pi.currency)
          : "—",
    },
    {
      header: "Status",
      render: (pi) => <StatusBadge status={pi.status} />,
    },
    ...(reportType === "group"
      ? [
          {
            header: "Client",
            render: (pi) => pi.clientId ?? "—",
          },
        ]
      : []),
  ];

  return (
    <div>
      <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
        <h4 className="text-md font-semibold text-white mb-4">Payment Reports</h4>

        {/* Report type toggle */}
        <div className="flex gap-6 mb-4">
          {reportTypes.map(({ value, label }) => (
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
              onChange={(e) => {
                setSelectedId(e.target.value);
                setReportEnabled(false);
              }}
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
                <option key={v} value={v}>
                  {v} results
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="button"
          onClick={handleRunReport}
          disabled={isFetching || !selectedId}
          className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium
                     transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isFetching ? "Loading..." : "Run Report"}
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
              <AdminTable columns={resultColumns} rows={results.data ?? []} keyField="id" />
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
