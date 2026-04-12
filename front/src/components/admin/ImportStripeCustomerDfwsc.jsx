import { useState } from "react";
import {
  useImportStripeCustomer,
  useStripeCustomers,
  useSyncStripeCustomer,
} from "../../hooks/useClients";
import logger from "../../utils/logger";
import AdminTable from "./shared/AdminTable";
import Button from "./shared/Button";
import ErrorMessage from "./shared/ErrorMessage";
import BaseModal from "./shared/BaseModal";

function DiscrepancyModal({ isOpen, onClose, discrepancy, onResolve, isResolving }) {
  const [resolutions, setResolutions] = useState({});

  if (!discrepancy) return null;

  const { differences = [] } = discrepancy;

  const handleResolution = (fieldName, source) => {
    setResolutions((prev) => ({ ...prev, [fieldName]: source }));
  };

  const handleUseLocalAll = () => {
    const allLocal = {};
    differences.forEach((d) => {
      allLocal[d.fieldName] = "local";
    });
    setResolutions(allLocal);
  };

  const handleUseStripeAll = () => {
    const allStripe = {};
    differences.forEach((d) => {
      allStripe[d.fieldName] = "stripe";
    });
    setResolutions(allStripe);
  };

  const handleSave = () => {
    const payload = Object.entries(resolutions).map(([fieldName, source]) => ({
      fieldName,
      source,
    }));
    onResolve(payload);
  };

  const hasAnyResolution = Object.keys(resolutions).length > 0;

  return (
    <BaseModal isOpen={isOpen} onClose={onClose} title="Resolve Data Discrepancies" size="lg">
      <div className="p-4">
        <div className="flex gap-2 mb-4">
          <Button size="sm" onClick={handleUseLocalAll}>
            Use Local for All
          </Button>
          <Button size="sm" onClick={handleUseStripeAll}>
            Use Stripe for All
          </Button>
        </div>

        <div className="space-y-3 mb-4">
          {differences.map((diff) => (
            <div
              key={diff.fieldName}
              className="flex items-center justify-between p-3 bg-gray-700/50 rounded"
            >
              <div className="flex-1">
                <div className="text-sm font-medium text-white capitalize">
                  {diff.fieldName.replace(/([A-Z])/g, " $1").trim()}
                </div>
                <div className="text-xs text-gray-400">
                  <span className="text-blue-300">Local:</span> {diff.localValue || "(empty)"}
                </div>
                <div className="text-xs text-gray-400">
                  <span className="text-green-300">Stripe:</span> {diff.stripeValue || "(empty)"}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={resolutions[diff.fieldName] === "local" ? "primary" : "secondary"}
                  onClick={() => handleResolution(diff.fieldName, "local")}
                >
                  Use Local
                </Button>
                <Button
                  size="sm"
                  variant={resolutions[diff.fieldName] === "stripe" ? "primary" : "secondary"}
                  onClick={() => handleResolution(diff.fieldName, "stripe")}
                >
                  Use Stripe
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!hasAnyResolution || isResolving}
            onClick={handleSave}
            isLoading={isResolving}
          >
            Save Resolutions
          </Button>
        </div>
      </div>
    </BaseModal>
  );
}

export default function ImportStripeCustomerDfwsc({ showToast }) {
  const {
    data: reconciliation,
    isLoading,
    isError,
    error,
    refetch,
  } = useStripeCustomers(undefined, "dfwsc_services");

  const importMutation = useImportStripeCustomer();
  const syncMutation = useSyncStripeCustomer();

  const [importedClientInfo, setImportedClientInfo] = useState(null);
  const [localError, setLocalError] = useState("");

  const [selectedDiscrepancy, setSelectedDiscrepancy] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleImport = (stripeCustomerId) => {
    setLocalError("");
    setImportedClientInfo(null);
    importMutation.mutate(
      { stripeCustomerId, workspace: "dfwsc_services" },
      {
        onSuccess: (data) => {
          setImportedClientInfo(data);
          showToast?.(`Client ${data.name} imported successfully!`, "success");
          refetch();
        },
        onError: (err) => {
          logger.error("Error importing Stripe customer:", err);
          setLocalError(err.message);
          showToast?.(`Error importing customer: ${err.message}`, "error");
        },
      }
    );
  };

  const handleReviewSync = (discrepancy) => {
    setSelectedDiscrepancy(discrepancy);
    setIsModalOpen(true);
  };

  const handleSync = (resolutions) => {
    if (!selectedDiscrepancy) return;

    syncMutation.mutate(
      {
        stripeCustomerId: selectedDiscrepancy.stripeCustomerId,
        localClientId: selectedDiscrepancy.localClientId,
        workspace: "dfwsc_services",
        resolutions,
      },
      {
        onSuccess: () => {
          showToast?.("Discrepancies resolved successfully!", "success");
          setIsModalOpen(false);
          setSelectedDiscrepancy(null);
          refetch();
        },
        onError: (err) => {
          logger.error("Error syncing customer:", err);
          setLocalError(err.message);
          showToast?.(`Error syncing customer: ${err.message}`, "error");
        },
      }
    );
  };

  const toImport = reconciliation?.toImport || [];
  const discrepancies = reconciliation?.discrepancies || [];
  const allGood = reconciliation?.allGood || [];

  const importColumns = [
    { header: "Name", key: "name", render: (c) => c.name || "Unnamed" },
    { header: "Email", key: "email", render: (c) => c.email || "No email" },
    {
      header: "Stripe ID",
      key: "stripeCustomerId",
      render: (c) => (
        <code className="text-xs bg-gray-900/50 p-1 rounded">{c.stripeCustomerId}</code>
      ),
    },
    {
      header: "Action",
      render: (c) => (
        <Button
          size="sm"
          onClick={() => handleImport(c.stripeCustomerId)}
          isLoading={
            importMutation.isPending &&
            importMutation.variables?.stripeCustomerId === c.stripeCustomerId
          }
          disabled={importMutation.isPending}
        >
          Import
        </Button>
      ),
    },
  ];

  const discrepancyColumns = [
    { header: "Name", key: "name", render: (c) => c.name || "Unnamed" },
    { header: "Email", key: "email", render: (c) => c.email || "No email" },
    {
      header: "Differences",
      key: "differences",
      render: (c) => <span className="text-yellow-400">{c.differences?.length || 0} field(s)</span>,
    },
    {
      header: "Action",
      render: (c) => (
        <Button size="sm" variant="secondary" onClick={() => handleReviewSync(c)}>
          Review Sync
        </Button>
      ),
    },
  ];

  const isEmpty = toImport.length === 0 && discrepancies.length === 0;

  return (
    <div className="mb-6">
      <DiscrepancyModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        discrepancy={selectedDiscrepancy}
        onResolve={handleSync}
        isResolving={syncMutation.isPending}
      />

      <div className="p-4 bg-gray-700/50 rounded-lg mb-4">
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
            aria-label="Sync"
          >
            <title>Sync Icon</title>
            <path d="M21 12a9 9 0 0 0-9-9v9l6.364 6.364a1 1 0 0 0 1.414-1.414L13.414 12" />
            <path d="M3 12a9 9 0 0 0 9 9V12L5.636 5.636A1 1 0 0 0 4.222 6.05L10.586 12" />
          </svg>
          Stripe Reconciliation
        </h4>

        <p className="text-sm text-gray-400 mb-4">
          Sync customers between Stripe and your DFWSC database.
        </p>

        <ErrorMessage message={localError} className="mb-2" />

        {isEmpty ? (
          <div className="p-8 text-center bg-green-900/20 border border-green-500/30 rounded-lg">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-12 w-12 text-green-400 mx-auto mb-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <p className="text-green-400 font-semibold">All synced up!</p>
            <p className="text-sm text-gray-400">No customers need importing or syncing.</p>
          </div>
        ) : (
          <>
            {toImport.length > 0 && (
              <div className="mb-6">
                <h5 className="text-sm font-semibold text-blue-400 mb-2">
                  Ready to Import ({toImport.length})
                </h5>
                <AdminTable
                  columns={importColumns}
                  rows={toImport}
                  isLoading={isLoading}
                  isError={isError}
                  error={error}
                  onRetry={refetch}
                  emptyMessage="No customers ready to import"
                  loadingMessage="Fetching from Stripe..."
                />
              </div>
            )}

            {discrepancies.length > 0 && (
              <div>
                <h5 className="text-sm font-semibold text-yellow-400 mb-2">
                  Data Discrepancies ({discrepancies.length})
                </h5>
                <AdminTable
                  columns={discrepancyColumns}
                  rows={discrepancies}
                  isLoading={isLoading}
                  isError={isError}
                  error={error}
                  onRetry={refetch}
                  emptyMessage="No discrepancies found"
                  loadingMessage="Fetching from Stripe..."
                />
              </div>
            )}
          </>
        )}
      </div>

      {importedClientInfo && (
        <div className="p-4 bg-gray-800/50 rounded-lg border border-gray-600">
          <h5 className="font-semibold text-green-400 mb-2">Import Successful!</h5>
          <p className="text-white">
            <strong>Client:</strong> {importedClientInfo.name}
          </p>
          <p className="text-gray-400 text-sm">
            <strong>ID:</strong> {importedClientInfo.clientId}
          </p>
        </div>
      )}
    </div>
  );
}
