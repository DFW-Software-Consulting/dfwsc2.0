import { useCallback, useEffect, useState } from "react";
import { useClients } from "../../hooks/useClients";
import {
  useCancelInvoice,
  useCreateInvoice,
  useInvoices,
  useMarkInvoicePaidOutOfBand,
} from "../../hooks/useInvoices";
import { useCreatePayment } from "../../hooks/usePayments";
import { useCreateProduct, useProducts } from "../../hooks/useProducts";
import { useTaxRates } from "../../hooks/useTaxRates";
import MarkInvoicePaidModal from "./MarkInvoicePaidModal";
import ErrorMessage from "./shared/ErrorMessage";
import LoadingSpinner from "./shared/LoadingSpinner";
import StatusBadge from "./shared/StatusBadge";

function formatUsd(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Invoices Sub-Tab ────────────────────────────────────────────────────────

function InvoicesTab({ showToast, isDfwscMode, workspace, preselectedClient }) {
  const workspaceLabel = isDfwscMode ? "DFWSC" : "Portal";
  const { data: clients = [] } = useClients({ workspace });
  const { data: invoices = [], isLoading, isError, error, refetch } = useInvoices({ workspace });
  const { data: products = [], isLoading: productsLoading } = useProducts();
  const { data: taxRates = [] } = useTaxRates();
  const createInvoiceMutation = useCreateInvoice();
  const cancelInvoiceMutation = useCancelInvoice();
  const markPaidOutOfBandMutation = useMarkInvoicePaidOutOfBand();
  const createProductMutation = useCreateProduct();

  const [oobInvoice, setOobInvoice] = useState(null);

  const [clientId, setClientId] = useState("");

  useEffect(() => {
    if (preselectedClient?.id) {
      setClientId(preselectedClient.id);
    } else {
      setClientId("");
    }
  }, [preselectedClient]);

  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [waiveFee, setWaiveFee] = useState(false);
  const [taxRateId, setTaxRateId] = useState("");
  const [formError, setFormError] = useState("");

  const [selectedProductId, setSelectedProductId] = useState("");
  const [showNewProduct, setShowNewProduct] = useState(false);
  const [newProductName, setNewProductName] = useState("");
  const [newProductDesc, setNewProductDesc] = useState("");
  const [newProductAmount, setNewProductAmount] = useState("");
  const [productFormError, setProductFormError] = useState("");

  const enteredAmountCents = Math.round((parseFloat(amount) || 0) * 100);
  const selectedTaxRate = taxRates.find((rate) => rate.id === taxRateId) ?? null;
  const estimatedInvoiceTaxCents = selectedTaxRate
    ? Math.round(enteredAmountCents * (selectedTaxRate.percentage / 100))
    : 0;
  const estimatedInvoiceTotalCents = enteredAmountCents + estimatedInvoiceTaxCents;

  const handleProductSelect = useCallback(
    (e) => {
      const id = e.target.value;
      setSelectedProductId(id);
      if (!id) return;
      const product = products.find((p) => p.id === id);
      if (product) {
        setDescription(
          product.description ? `${product.name} — ${product.description}` : product.name
        );
        if (product.defaultPrice) {
          setAmount((product.defaultPrice.amountCents / 100).toFixed(2));
        }
      }
    },
    [products]
  );

  const handleCreateProduct = useCallback(() => {
    setProductFormError("");
    if (!newProductName.trim()) return setProductFormError("Product name is required.");
    const amountCents = Math.round(parseFloat(newProductAmount) * 100);
    if (Number.isNaN(amountCents) || amountCents <= 0)
      return setProductFormError("Enter a valid price.");

    createProductMutation.mutate(
      {
        name: newProductName.trim(),
        description: newProductDesc.trim() || undefined,
        amountCents,
      },
      {
        onSuccess: (product) => {
          setSelectedProductId(product.id);
          setDescription(
            product.description ? `${product.name} — ${product.description}` : product.name
          );
          if (product.defaultPrice) {
            setAmount((product.defaultPrice.amountCents / 100).toFixed(2));
          }
          setNewProductName("");
          setNewProductDesc("");
          setNewProductAmount("");
          setShowNewProduct(false);
          showToast?.("Product created.", "success");
        },
        onError: (err) => setProductFormError(err.message),
      }
    );
  }, [newProductName, newProductDesc, newProductAmount, createProductMutation, showToast]);

  const handleCreate = useCallback(
    (e) => {
      e.preventDefault();
      setFormError("");
      const amountCents = Math.round(parseFloat(amount) * 100);
      const targetClientId = clientId;

      if (!targetClientId) return setFormError("Select a client.");
      if (Number.isNaN(amountCents) || amountCents <= 0)
        return setFormError("Enter a valid amount.");
      if (!description.trim()) return setFormError("Description is required.");

      createInvoiceMutation.mutate(
        {
          clientId: targetClientId,
          workspace,
          amountCents,
          description: description.trim(),
          dueDate: dueDate || null,
          waiveFee,
          taxRateId: taxRateId || null,
        },
        {
          onSuccess: () => {
            setClientId("");
            setAmount("");
            setDescription("");
            setDueDate("");
            setWaiveFee(false);
            setTaxRateId("");
            setSelectedProductId("");
            showToast?.("Invoice created and email sent.", "success");
          },
          onError: (err) => setFormError(err.message),
        }
      );
    },
    [
      clientId,
      amount,
      description,
      dueDate,
      waiveFee,
      taxRateId,
      workspace,
      createInvoiceMutation,
      showToast,
    ]
  );

  const handleCancel = useCallback(
    (id) => {
      cancelInvoiceMutation.mutate(id, {
        onSuccess: () => showToast?.("Invoice cancelled.", "success"),
        onError: (err) => showToast?.(err.message, "error"),
      });
    },
    [cancelInvoiceMutation, showToast]
  );

  const handleOpenLink = useCallback((url) => {
    window.open(url, "_blank");
  }, []);

  const handleMarkPaidConfirm = useCallback(
    (body) => {
      if (!oobInvoice) return;
      markPaidOutOfBandMutation.mutate(
        { id: oobInvoice.id, ...body },
        {
          onSuccess: () => {
            showToast?.("Invoice marked paid.", "success");
            setOobInvoice(null);
          },
          onError: (err) => showToast?.(err.message, "error"),
        }
      );
    },
    [markPaidOutOfBandMutation, oobInvoice, showToast]
  );

  return (
    <div>
      {/* Create form */}
      <div className="mb-6 p-4 bg-gray-700/30 rounded-lg border border-gray-700">
        <h4 className="text-md font-semibold text-white mb-3 flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-blue-400">
            <span className="w-2 h-2 rounded-full bg-blue-400"></span>
            {`New ${workspaceLabel} Invoice`}
          </span>
        </h4>
        <form onSubmit={handleCreate} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="inv-client" className="block text-sm text-gray-300 mb-1">
              Client
            </label>
            <select
              id="inv-client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                           focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createInvoiceMutation.isPending}
            >
              <option value="">Select client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Product dropdown */}
          <div className="sm:col-span-2">
            <label htmlFor="inv-product" className="block text-sm text-gray-300 mb-1">
              Product (optional)
            </label>
            <div className="flex gap-2">
              <select
                id="inv-product"
                value={selectedProductId}
                onChange={handleProductSelect}
                className="flex-1 rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                           focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={createInvoiceMutation.isPending || productsLoading}
              >
                <option value="">{productsLoading ? "Loading…" : "Select product…"}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.defaultPrice ? ` — $${(p.defaultPrice.amountCents / 100).toFixed(2)}` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  setShowNewProduct((v) => !v);
                  setProductFormError("");
                }}
                title="Create new Stripe product"
                className="px-3 py-2 rounded-md bg-gray-600 hover:bg-gray-500 text-white text-sm
                           whitespace-nowrap transition-colors"
              >
                + New
              </button>
            </div>
          </div>

          {/* Inline new-product form */}
          {showNewProduct && (
            <div className="sm:col-span-2 p-3 bg-gray-800/70 rounded-lg border border-gray-600">
              <h5 className="text-sm font-semibold text-gray-200 mb-2">Create Stripe Product</h5>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label htmlFor="np-name" className="block text-xs text-gray-400 mb-1">
                    Name
                  </label>
                  <input
                    id="np-name"
                    type="text"
                    value={newProductName}
                    onChange={(e) => setNewProductName(e.target.value)}
                    placeholder="e.g. Website Maintenance"
                    className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-1.5 text-sm
                               text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="np-price" className="block text-xs text-gray-400 mb-1">
                    Default Price ($)
                  </label>
                  <input
                    id="np-price"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={newProductAmount}
                    onChange={(e) => setNewProductAmount(e.target.value)}
                    placeholder="e.g. 99.00"
                    className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-1.5 text-sm
                               text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="sm:col-span-2 flex items-center gap-2">
                  {productFormError && (
                    <p className="text-red-400 text-xs flex-1">{productFormError}</p>
                  )}
                  <button
                    type="button"
                    onClick={handleCreateProduct}
                    disabled={createProductMutation.isPending}
                    className="ml-auto px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm
                               transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {createProductMutation.isPending ? "Creating…" : "Create & Select"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowNewProduct(false);
                      setProductFormError("");
                    }}
                    className="px-3 py-1.5 rounded-md bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Amount */}
          <div>
            <label htmlFor="inv-amount" className="block text-sm text-gray-300 mb-1">
              Amount ($)
            </label>
            <input
              id="inv-amount"
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 99.00"
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createInvoiceMutation.isPending}
            />
          </div>

          {/* Due date */}
          <div>
            <label htmlFor="inv-date" className="block text-sm text-gray-300 mb-1">
              Due Date (optional)
            </label>
            <input
              id="inv-date"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createInvoiceMutation.isPending}
            />
          </div>

          {/* Description */}
          <div>
            <label htmlFor="inv-tax-rate" className="block text-sm text-gray-300 mb-1">
              Tax (optional)
            </label>
            <select
              id="inv-tax-rate"
              value={taxRateId}
              onChange={(e) => setTaxRateId(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createInvoiceMutation.isPending}
            >
              <option value="">No tax</option>
              {taxRates.map((rate) => (
                <option key={rate.id} value={rate.id}>
                  {rate.displayName} ({rate.percentage}%)
                </option>
              ))}
            </select>
          </div>

          {selectedTaxRate && enteredAmountCents > 0 && (
            <div className="sm:col-span-2 rounded-md border border-blue-700/40 bg-blue-900/20 p-3 text-sm">
              <p className="text-blue-200">
                Estimated tax ({selectedTaxRate.percentage}%): {formatUsd(estimatedInvoiceTaxCents)}
              </p>
              <p className="text-white font-medium">
                Estimated total before processing fee: {formatUsd(estimatedInvoiceTotalCents)}
              </p>
              {!waiveFee && (
                <p className="text-xs text-gray-300 mt-1">
                  Processing fee is calculated at send time and may increase final total.
                </p>
              )}
            </div>
          )}

          <div className="sm:col-span-2">
            <label htmlFor="inv-desc" className="block text-sm text-gray-300 mb-1">
              Description
            </label>
            <input
              id="inv-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={isDfwscMode ? "e.g. Consulting Fee" : "e.g. Project Fee"}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createInvoiceMutation.isPending}
            />
          </div>

          {/* Waive Fee */}
          <div className="flex items-center space-x-2 pt-2">
            <input
              id="inv-waive"
              type="checkbox"
              checked={waiveFee}
              onChange={(e) => setWaiveFee(e.target.checked)}
              className="w-4 h-4 rounded border-gray-600 bg-gray-900 text-blue-500 focus:ring-blue-500"
              disabled={createInvoiceMutation.isPending}
            />
            <label htmlFor="inv-waive" className="text-sm text-gray-300">
              Waive Processing Fee
            </label>
          </div>

          <div className="sm:col-span-2 flex items-center justify-between mt-2">
            <ErrorMessage message={formError} />
            <button
              type="submit"
              disabled={createInvoiceMutation.isPending}
              className="px-6 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium
                         transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
            >
              {createInvoiceMutation.isPending
                ? "Sending..."
                : `Send ${workspaceLabel} Invoice`}
            </button>
          </div>
        </form>
      </div>

      {/* List */}
      <div className="flex justify-between items-center mb-3">
        <h4 className="text-md font-semibold text-white">
          {`${workspaceLabel} Invoices`}
        </h4>
        <button
          type="button"
          onClick={() => refetch()}
          className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>

      {isLoading && <LoadingSpinner message="Loading invoices..." />}
      {isError && <p className="text-red-400 text-sm py-4 text-center">{error?.message}</p>}
      {!isLoading && !isError && invoices.length === 0 && (
        <p className="text-gray-400 text-sm py-4 text-center">No invoices yet</p>
      )}

      {invoices.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-700">
            <thead>
              <tr>
                {["Client", "Description", "Amount", "Due", "Status", "Actions"].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left text-xs font-medium text-gray-300 uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-gray-700/50">
                  <td className="px-3 py-2 text-sm text-gray-200">{inv.clientName ?? "—"}</td>
                  <td className="px-3 py-2 text-sm text-gray-200 max-w-xs truncate">
                    {inv.description}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-200">
                    ${(inv.amountCents / 100).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-400">
                    {inv.dueDate
                      ? new Date(inv.dueDate).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <StatusBadge status={inv.status} />
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <div className="flex gap-2">
                      {inv.hostedUrl && (
                        <button
                          type="button"
                          onClick={() => handleOpenLink(inv.hostedUrl)}
                          className="px-2 py-1 rounded text-xs bg-gray-600 hover:bg-gray-500 text-white transition-colors"
                        >
                          Open
                        </button>
                      )}
                      {inv.status === "open" && (
                        <>
                          <button
                            type="button"
                            onClick={() => setOobInvoice(inv)}
                            className="px-2 py-1 rounded text-xs bg-green-700 hover:bg-green-600 text-white transition-colors"
                          >
                            Mark Paid
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCancel(inv.id)}
                            className="px-2 py-1 rounded text-xs bg-red-700 hover:bg-red-600 text-white transition-colors"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <MarkInvoicePaidModal
        isOpen={!!oobInvoice}
        invoice={oobInvoice}
        onClose={() => setOobInvoice(null)}
        onConfirm={handleMarkPaidConfirm}
        isLoading={markPaidOutOfBandMutation.isPending}
      />
    </div>
  );
}

// ─── Payments Sub-Tab ────────────────────────────────────────────────────────

function PaymentsTab({ showToast, isDfwscMode, workspace }) {
  const workspaceLabel = isDfwscMode ? "DFWSC" : "Portal";
  const { data: clients = [] } = useClients({ workspace });
  const createPaymentMutation = useCreatePayment();

  const [clientId, setClientId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [waiveFee, setWaiveFee] = useState(false);
  const [formError, setFormError] = useState("");
  const [lastLink, setLastLink] = useState("");

  const handleCreateLink = useCallback(
    (e) => {
      e.preventDefault();
      setFormError("");
      setLastLink("");
      const amountValue = parseFloat(amount);
      const targetClientId = clientId;

      if (!targetClientId) return setFormError("Select a client.");
      if (Number.isNaN(amountValue) || amountValue <= 0)
        return setFormError("Enter a valid amount.");
      if (!description.trim()) return setFormError("Description is required.");

      const amountCents = Math.round(amountValue * 100);

      createPaymentMutation.mutate(
        {
          amount: amountCents,
          currency: "usd",
          description: description.trim(),
          waiveFee,
          workspace,
          metadata: { clientId: targetClientId },
          lineItems: [
            {
              price_data: {
                currency: "usd",
                product_data: { name: description.trim() },
                unit_amount: amountCents,
              },
              quantity: 1,
            },
          ],
        },
        {
          onSuccess: (res) => {
            setLastLink(res.url);
            showToast?.("Payment link generated.", "success");
          },
          onError: (err) => setFormError(err.message),
        }
      );
    },
    [clientId, amount, description, waiveFee, workspace, createPaymentMutation, showToast]
  );

  return (
    <div>
      <div className="mb-6 p-4 bg-gray-700/30 rounded-lg border border-gray-700">
        <h4 className="text-md font-semibold text-white mb-3 flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-blue-400">
            <span className="w-2 h-2 rounded-full bg-blue-400"></span>
            {`New ${workspaceLabel} Payment Link`}
          </span>
        </h4>
        <form onSubmit={handleCreateLink} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="pay-client" className="block text-sm text-gray-300 mb-1">
              Client
            </label>
            <select
              id="pay-client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createPaymentMutation.isPending}
            >
              <option value="">Select client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Amount */}
          <div className="sm:col-span-2">
            <label htmlFor="pay-amount" className="block text-sm text-gray-300 mb-1">
              Amount ($)
            </label>
            <input
              id="pay-amount"
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="99.00"
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createPaymentMutation.isPending}
            />
          </div>

          {/* Description */}
          <div className="sm:col-span-2">
            <label htmlFor="pay-desc" className="block text-sm text-gray-300 mb-1">
              Description
            </label>
            <input
              id="pay-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={isDfwscMode ? "e.g. Expedited Project Fee" : "e.g. One-time service"}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createPaymentMutation.isPending}
            />
          </div>

          {/* Waive Fee */}
          <div className="flex items-center space-x-2 pt-2">
            <input
              id="pay-waive"
              type="checkbox"
              checked={waiveFee}
              onChange={(e) => setWaiveFee(e.target.checked)}
              className="w-4 h-4 rounded border-gray-600 bg-gray-900 text-blue-500 focus:ring-blue-500"
              disabled={createPaymentMutation.isPending}
            />
            <label htmlFor="pay-waive" className="text-sm text-gray-300">
              Waive Processing Fee
            </label>
          </div>

          <div className="sm:col-span-2 flex items-center justify-between mt-2">
            <ErrorMessage message={formError} />
            <button
              type="submit"
              className="bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-6 rounded-md transition shadow-lg disabled:opacity-50"
              disabled={createPaymentMutation.isPending}
            >
              {createPaymentMutation.isPending
                ? "Generating…"
                : `Generate ${workspaceLabel} Link`}
            </button>
          </div>
        </form>

        {lastLink && (
          <div className="mt-4 p-3 bg-green-900/30 border border-green-700/50 rounded-md">
            <p className="text-sm text-green-300 mb-2 font-medium">Link Generated Successfully:</p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={lastLink}
                className="flex-1 bg-gray-900/80 text-xs text-gray-300 p-2 rounded border border-gray-700"
              />
              <button
                type="button"
                onClick={() => window.open(lastLink, "_blank")}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded transition shadow"
              >
                Open Link
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SubscriptionsTab() {
  return null;
}

// ─── BillingPanel ────────────────────────────────────────────────────────────

const BILLING_TABS = [
  { id: "invoices", label: "Invoices" },
  { id: "payments", label: "Payment Links" },
];

export default function BillingPanel({
  showToast,
  workspace = "client_portal",
  isDfwscMode = false,
  initialSubTab,
  preselectedClient,
}) {
  const [activeTab, setActiveTab] = useState(initialSubTab || "invoices");

  return (
    <div className="space-y-6">
      <div className="border-b border-gray-700/50 flex justify-center gap-8">
        {BILLING_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`pb-3 text-sm font-semibold transition-all border-b-2 -mb-px ${
              activeTab === tab.id
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
        {activeTab === "invoices" && (
          <InvoicesTab
            showToast={showToast}
            isDfwscMode={isDfwscMode}
            workspace={workspace}
            preselectedClient={preselectedClient}
          />
        )}
        {activeTab === "payments" && (
          <PaymentsTab showToast={showToast} isDfwscMode={isDfwscMode} workspace={workspace} />
        )}
      </div>
    </div>
  );
}
