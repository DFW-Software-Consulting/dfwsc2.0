import { useState } from "react";
import { useImportStripeCustomer, useStripeCustomers } from "../../hooks/useClients";
import { useGroups } from "../../hooks/useGroups";
import logger from "../../utils/logger";
import AdminTable from "./shared/AdminTable";
import Button from "./shared/Button";
import ErrorMessage from "./shared/ErrorMessage";

export default function ImportStripeCustomer({ showToast, workspace = "client_portal" }) {
  const isDfwscMode = workspace === "dfwsc_services";
  const startingAfter = undefined;
  const {
    data: stripeCustomers = { data: [], has_more: false },
    isLoading,
    isError,
    error,
    refetch,
  } = useStripeCustomers(startingAfter, workspace);

  const { data: groups = [], isLoading: isLoadingGroups } = useGroups(workspace);
  const importMutation = useImportStripeCustomer();
  const [importedClientInfo, setImportedClientInfo] = useState(null);
  const [localError, setLocalError] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");

  const handleImport = (customerId) => {
    setLocalError("");
    setImportedClientInfo(null);
    importMutation.mutate(
      {
        stripeCustomerId: customerId,
        groupId: !isDfwscMode && selectedGroupId ? selectedGroupId : undefined,
        workspace,
      },
      {
        onSuccess: (data) => {
          setImportedClientInfo(data);
          showToast?.(`Client ${data.name} imported successfully!`, "success");
          refetch(); // Refresh the list to remove the imported customer
        },
        onError: (err) => {
          logger.error("Error importing Stripe customer:", err);
          setLocalError(err.message);
          showToast?.(`Error importing customer: ${err.message}`, "error");
        },
      }
    );
  };

  const copyToClipboard = async (text, type) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast?.(`${type} copied to clipboard!`, "success");
    } catch (err) {
      logger.error(`Failed to copy ${type}:`, err);
      showToast?.(`Failed to copy ${type}`, "error");
    }
  };

  const columns = [
    { header: "Name", key: "name" },
    { header: "Email", key: "email" },
    {
      header: "Stripe ID",
      key: "id",
      render: (c) => <code className="text-xs bg-gray-900/50 p-1 rounded">{c.id}</code>,
    },
    {
      header: "Action",
      render: (c) => (
        <Button
          size="sm"
          onClick={() => handleImport(c.id)}
          isLoading={
            importMutation.isPending && importMutation.variables?.stripeCustomerId === c.id
          }
          disabled={importMutation.isPending}
        >
          Import
        </Button>
      ),
    },
  ];

  return (
    <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
      <h4 className="text-md font-semibold text-white mb-3 flex items-center gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5 text-blue-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          role="img"
          aria-label="Import"
        >
          <title>Import Icon</title>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Pull Existing Customers from Stripe
      </h4>

      <p className="text-sm text-gray-400 mb-4">
        Select a customer from your main Stripe account to import them into the portal.
      </p>

      {!isDfwscMode && (
        <div className="mb-6 max-w-sm">
          <label htmlFor="import-group-id" className="block text-xs font-medium text-gray-400 mb-1">
            ASSIGN TO GROUP (OPTIONAL)
          </label>
          <select
            id="import-group-id"
            value={selectedGroupId}
            onChange={(e) => setSelectedGroupId(e.target.value)}
            disabled={isLoadingGroups}
            className="w-full bg-gray-900/50 border border-gray-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
          >
            <option value="">No Group (Independent)</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <AdminTable
        columns={columns}
        rows={stripeCustomers.data}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={refetch}
        emptyMessage="No more customers found in Stripe to import"
        loadingMessage="Fetching customers from Stripe..."
      />

      <ErrorMessage message={localError} className="mt-2" />

      {importedClientInfo && (
        <div className="mt-4 p-4 bg-gray-800/50 rounded-lg border border-gray-600">
          <h5 className="font-semibold text-green-400 mb-2">Import Successful!</h5>

          <div className="mb-4 p-3 bg-red-900/20 border border-red-500/30 rounded-md">
            <p className="text-sm text-red-300 font-bold mb-1">⚠️ API KEY (SHOWN ONLY ONCE):</p>
            <div className="flex items-center">
              <code className="flex-1 bg-gray-900/50 text-red-300 p-2 rounded break-all mr-2 font-mono text-xs">
                {importedClientInfo.apiKey}
              </code>
              <button
                type="button"
                onClick={() => copyToClipboard(importedClientInfo.apiKey, "API Key")}
                className="text-sm bg-red-800/40 hover:bg-red-800/60 text-white py-1 px-3 rounded transition-colors"
              >
                Copy
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-2 italic">
              Treat this key like a password. It cannot be recovered if lost.
            </p>
          </div>

          <div className="mb-3">
            <p className="text-sm text-gray-300 mb-1">
              <strong>Onboarding Token:</strong>
            </p>
            <div className="flex items-center">
              <code className="flex-1 bg-gray-900/50 text-green-300 p-2 rounded break-all mr-2 text-xs">
                {importedClientInfo.onboardingToken}
              </code>
              <button
                type="button"
                onClick={() => copyToClipboard(importedClientInfo.onboardingToken, "Token")}
                className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded transition-colors"
              >
                Copy
              </button>
            </div>
          </div>

          <div>
            <p className="text-sm text-gray-300 mb-1">
              <strong>Onboarding URL:</strong>
            </p>
            <div className="flex items-center">
              <code className="flex-1 bg-gray-900/50 text-blue-300 p-2 rounded break-all mr-2 text-xs">
                {importedClientInfo.onboardingUrlHint}
              </code>
              <button
                type="button"
                onClick={() => copyToClipboard(importedClientInfo.onboardingUrlHint, "URL")}
                className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded transition-colors"
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
