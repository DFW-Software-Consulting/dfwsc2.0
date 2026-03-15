import { useCallback, useState } from "react";
import { useClients } from "../../hooks/useClients";
import { useCancelInvoice, useCreateInvoice, useInvoices } from "../../hooks/useInvoices";
import { useCreateProduct, useProducts } from "../../hooks/useProducts";
import {
  useCreateSubscription,
  usePatchSubscription,
  useSubscriptionDetail,
  useSubscriptions,
} from "../../hooks/useSubscriptions";
import ErrorMessage from "./shared/ErrorMessage";
import LoadingSpinner from "./shared/LoadingSpinner";
import StatusBadge from "./shared/StatusBadge";

// ─── Invoices Sub-Tab ────────────────────────────────────────────────────────

function InvoicesTab({ showToast }) {
  const { data: clients = [] } = useClients();
  const { data: invoices = [], isLoading, isError, error, refetch } = useInvoices({});
  const { data: products = [], isLoading: productsLoading } = useProducts();
  const createInvoiceMutation = useCreateInvoice();
  const cancelInvoiceMutation = useCancelInvoice();
  const createProductMutation = useCreateProduct();

  const [clientId, setClientId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [formError, setFormError] = useState("");

  const [selectedProductId, setSelectedProductId] = useState("");
  const [showNewProduct, setShowNewProduct] = useState(false);
  const [newProductName, setNewProductName] = useState("");
  const [newProductDesc, setNewProductDesc] = useState("");
  const [newProductAmount, setNewProductAmount] = useState("");
  const [productFormError, setProductFormError] = useState("");

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
      if (!clientId) return setFormError("Select a client.");
      if (Number.isNaN(amountCents) || amountCents <= 0)
        return setFormError("Enter a valid amount.");
      if (!description.trim()) return setFormError("Description is required.");

      createInvoiceMutation.mutate(
        { clientId, amountCents, description: description.trim(), dueDate: dueDate || null },
        {
          onSuccess: () => {
            setClientId("");
            setAmount("");
            setDescription("");
            setDueDate("");
            setSelectedProductId("");
            showToast?.("Invoice created and email sent.", "success");
          },
          onError: (err) => setFormError(err.message),
        }
      );
    },
    [clientId, amount, description, dueDate, createInvoiceMutation, showToast]
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

  const handleCopyLink = useCallback(
    (token) => {
      const url = `${window.location.origin}/pay/${token}`;
      navigator.clipboard.writeText(url).then(() => {
        showToast?.("Payment link copied.", "success");
      });
    },
    [showToast]
  );

  return (
    <div>
      {/* Create form */}
      <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
        <h4 className="text-md font-semibold text-white mb-3">New Invoice</h4>
        <form onSubmit={handleCreate} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Client */}
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
          <div>
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
                <div className="sm:col-span-2">
                  <label htmlFor="np-desc" className="block text-xs text-gray-400 mb-1">
                    Description (optional)
                  </label>
                  <input
                    id="np-desc"
                    type="text"
                    value={newProductDesc}
                    onChange={(e) => setNewProductDesc(e.target.value)}
                    placeholder="e.g. Monthly site maintenance and updates"
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

          {/* Description */}
          <div className="sm:col-span-2">
            <label htmlFor="inv-desc" className="block text-sm text-gray-300 mb-1">
              Description
            </label>
            <input
              id="inv-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Website maintenance — March 2026"
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createInvoiceMutation.isPending}
            />
          </div>

          {/* Due date */}
          <div>
            <label htmlFor="inv-due" className="block text-sm text-gray-300 mb-1">
              Due Date (optional)
            </label>
            <input
              id="inv-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createInvoiceMutation.isPending}
            />
          </div>
          <div className="flex items-end">
            <ErrorMessage message={formError} className="mr-3" />
            <button
              type="submit"
              disabled={createInvoiceMutation.isPending}
              className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium
                         transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {createInvoiceMutation.isPending ? "Creating..." : "Create Invoice"}
            </button>
          </div>
        </form>
      </div>

      {/* List */}
      <div className="flex justify-between items-center mb-3">
        <h4 className="text-md font-semibold text-white">Invoices</h4>
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
                      <button
                        type="button"
                        onClick={() => handleCopyLink(inv.paymentToken)}
                        className="px-2 py-1 rounded text-xs bg-gray-600 hover:bg-gray-500 text-white transition-colors"
                      >
                        Copy link
                      </button>
                      {inv.status === "pending" && (
                        <button
                          type="button"
                          onClick={() => handleCancel(inv.id)}
                          className="px-2 py-1 rounded text-xs bg-red-700 hover:bg-red-600 text-white transition-colors"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Subscriptions Sub-Tab ───────────────────────────────────────────────────

function SubscriptionsTab({ showToast }) {
  const { data: clients = [] } = useClients();
  const { data: subs = [], isLoading, isError, error, refetch } = useSubscriptions({});
  const createSubMutation = useCreateSubscription();
  const patchSubMutation = usePatchSubscription();

  const [expandedId, setExpandedId] = useState(null);
  const { data: subDetail } = useSubscriptionDetail(expandedId, { enabled: !!expandedId });

  const [clientId, setClientId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [interval, setInterval] = useState("monthly");
  const [totalPayments, setTotalPayments] = useState("");
  const [formError, setFormError] = useState("");

  const [editingSub, setEditingSub] = useState(null);
  const [editTotalPayments, setEditTotalPayments] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editError, setEditError] = useState("");

  const handleCreate = useCallback(
    (e) => {
      e.preventDefault();
      setFormError("");
      const amountCents = Math.round(parseFloat(amount) * 100);
      if (!clientId) return setFormError("Select a client.");
      if (Number.isNaN(amountCents) || amountCents <= 0)
        return setFormError("Enter a valid amount.");
      if (!description.trim()) return setFormError("Description is required.");

      const total = totalPayments ? parseInt(totalPayments, 10) : null;
      if (totalPayments && (Number.isNaN(total) || total <= 0))
        return setFormError("Total payments must be a positive integer.");

      createSubMutation.mutate(
        { clientId, amountCents, description: description.trim(), interval, totalPayments: total },
        {
          onSuccess: () => {
            setClientId("");
            setAmount("");
            setDescription("");
            setInterval("monthly");
            setTotalPayments("");
            showToast?.("Subscription created and first invoice sent.", "success");
          },
          onError: (err) => setFormError(err.message),
        }
      );
    },
    [clientId, amount, description, interval, totalPayments, createSubMutation, showToast]
  );

  const handleStatusChange = useCallback(
    (id, status) => {
      patchSubMutation.mutate(
        { id, body: { status } },
        {
          onSuccess: () => showToast?.(`Subscription ${status}.`, "success"),
          onError: (err) => showToast?.(err.message, "error"),
        }
      );
    },
    [patchSubMutation, showToast]
  );

  const handleViewInvoices = useCallback((id) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const openEdit = useCallback((sub) => {
    setEditingSub(sub);
    setEditTotalPayments(sub.totalPayments != null ? String(sub.totalPayments) : "");
    setEditAmount((sub.amountCents / 100).toFixed(2));
    setEditDescription(sub.description);
    setEditError("");
  }, []);

  const handleEditSubmit = useCallback(
    (e) => {
      e.preventDefault();
      setEditError("");
      const body = {};

      const newAmount = Math.round(parseFloat(editAmount) * 100);
      if (Number.isNaN(newAmount) || newAmount <= 0) return setEditError("Enter a valid amount.");
      body.amountCents = newAmount;

      if (!editDescription.trim()) return setEditError("Description is required.");
      body.description = editDescription.trim();

      if (editTotalPayments === "") {
        body.totalPayments = null;
      } else {
        const tp = parseInt(editTotalPayments, 10);
        if (Number.isNaN(tp) || tp < 1 || !Number.isInteger(tp))
          return setEditError("Total payments must be a positive integer.");
        body.totalPayments = tp;
      }

      patchSubMutation.mutate(
        { id: editingSub.id, body },
        {
          onSuccess: () => {
            setEditingSub(null);
            showToast?.("Subscription updated.", "success");
          },
          onError: (err) => setEditError(err.message),
        }
      );
    },
    [editingSub, editAmount, editDescription, editTotalPayments, patchSubMutation, showToast]
  );

  const expandedInvoices = subDetail?.invoices ?? [];

  return (
    <div>
      {/* Create form */}
      <div className="mb-6 p-4 bg-gray-700/50 rounded-lg">
        <h4 className="text-md font-semibold text-white mb-3">New Subscription</h4>
        <form onSubmit={handleCreate} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="sub-client" className="block text-sm text-gray-300 mb-1">
              Client
            </label>
            <select
              id="sub-client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createSubMutation.isPending}
            >
              <option value="">Select client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sub-amount" className="block text-sm text-gray-300 mb-1">
              Amount ($)
            </label>
            <input
              id="sub-amount"
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 150.00"
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createSubMutation.isPending}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="sub-desc" className="block text-sm text-gray-300 mb-1">
              Description
            </label>
            <input
              id="sub-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Monthly hosting plan"
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createSubMutation.isPending}
            />
          </div>
          <div>
            <label htmlFor="sub-interval" className="block text-sm text-gray-300 mb-1">
              Billing Interval
            </label>
            <select
              id="sub-interval"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createSubMutation.isPending}
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <div>
            <label htmlFor="sub-total" className="block text-sm text-gray-300 mb-1">
              Total Payments (optional, blank = indefinite)
            </label>
            <input
              id="sub-total"
              type="number"
              min="1"
              step="1"
              value={totalPayments}
              onChange={(e) => setTotalPayments(e.target.value)}
              placeholder="e.g. 12"
              className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                         placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={createSubMutation.isPending}
            />
          </div>
          <div className="sm:col-span-2 flex items-center gap-3">
            <ErrorMessage message={formError} />
            <button
              type="submit"
              disabled={createSubMutation.isPending}
              className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium
                         transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {createSubMutation.isPending ? "Creating..." : "Create Subscription"}
            </button>
          </div>
        </form>
      </div>

      {/* List */}
      <div className="flex justify-between items-center mb-3">
        <h4 className="text-md font-semibold text-white">Subscriptions</h4>
        <button
          type="button"
          onClick={() => refetch()}
          className="text-sm bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded-md transition-colors"
        >
          Refresh
        </button>
      </div>

      {isLoading && <LoadingSpinner message="Loading subscriptions..." />}
      {isError && <p className="text-red-400 text-sm py-4 text-center">{error?.message}</p>}
      {!isLoading && !isError && subs.length === 0 && (
        <p className="text-gray-400 text-sm py-4 text-center">No subscriptions yet</p>
      )}

      {subs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-700">
            <thead>
              <tr>
                {["Client", "Description", "Amount", "Progress", "Status", "Actions"].map((h) => (
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
              {subs.map((sub) => (
                <>
                  <tr key={sub.id} className="hover:bg-gray-700/50">
                    <td className="px-3 py-2 text-sm text-gray-200">{sub.clientName ?? "—"}</td>
                    <td className="px-3 py-2 text-sm text-gray-200 max-w-xs truncate">
                      {sub.description}
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-200">
                      ${(sub.amountCents / 100).toFixed(2)} / {sub.interval}
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-400">
                      {sub.totalPayments != null
                        ? `${sub.paymentsMade} / ${sub.totalPayments} payments`
                        : `${sub.paymentsMade} payments made`}
                    </td>
                    <td className="px-3 py-2 text-sm">
                      <StatusBadge status={sub.status} />
                    </td>
                    <td className="px-3 py-2 text-sm">
                      <div className="flex gap-2 flex-wrap">
                        {sub.status === "active" && (
                          <button
                            type="button"
                            onClick={() => handleStatusChange(sub.id, "paused")}
                            className="px-2 py-1 rounded text-xs bg-yellow-700 hover:bg-yellow-600 text-white transition-colors"
                          >
                            Pause
                          </button>
                        )}
                        {sub.status === "paused" && (
                          <button
                            type="button"
                            onClick={() => handleStatusChange(sub.id, "active")}
                            className="px-2 py-1 rounded text-xs bg-green-700 hover:bg-green-600 text-white transition-colors"
                          >
                            Resume
                          </button>
                        )}
                        {(sub.status === "active" || sub.status === "paused") && (
                          <button
                            type="button"
                            onClick={() => handleStatusChange(sub.id, "cancelled")}
                            className="px-2 py-1 rounded text-xs bg-red-700 hover:bg-red-600 text-white transition-colors"
                          >
                            Cancel
                          </button>
                        )}
                        {(sub.status === "active" || sub.status === "paused") && (
                          <button
                            type="button"
                            onClick={() => openEdit(sub)}
                            className="px-2 py-1 rounded text-xs bg-indigo-700 hover:bg-indigo-600 text-white transition-colors"
                          >
                            Edit
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleViewInvoices(sub.id)}
                          className="px-2 py-1 rounded text-xs bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                        >
                          {expandedId === sub.id ? "Hide" : "Invoices"}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === sub.id && (
                    <tr className="bg-gray-800/50">
                      <td colSpan={6} className="px-4 py-3">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                          Invoices ({expandedInvoices.length})
                        </p>
                        {expandedInvoices.length === 0 ? (
                          <p className="text-gray-500 text-sm italic">No invoices yet.</p>
                        ) : (
                          <div className="grid gap-1">
                            {expandedInvoices.map((inv) => (
                              <div
                                key={inv.id}
                                className="flex justify-between items-center bg-gray-700/50 rounded px-3 py-2 text-sm"
                              >
                                <span className="text-gray-300">{inv.description}</span>
                                <div className="flex items-center gap-3">
                                  <span className="text-gray-400">
                                    ${(inv.amountCents / 100).toFixed(2)}
                                  </span>
                                  <StatusBadge status={inv.status} />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit modal */}
      {editingSub && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold text-white mb-4">Edit Subscription</h3>
            <form onSubmit={handleEditSubmit} className="grid gap-3">
              <div>
                <label htmlFor="edit-amount" className="block text-sm text-gray-300 mb-1">
                  Amount ($)
                </label>
                <input
                  id="edit-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={editAmount}
                  onChange={(e) => setEditAmount(e.target.value)}
                  className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                             focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={patchSubMutation.isPending}
                />
              </div>
              <div>
                <label htmlFor="edit-desc" className="block text-sm text-gray-300 mb-1">
                  Description
                </label>
                <input
                  id="edit-desc"
                  type="text"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                             focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={patchSubMutation.isPending}
                />
              </div>
              <div>
                <label htmlFor="edit-total" className="block text-sm text-gray-300 mb-1">
                  Total Payments (blank = indefinite)
                </label>
                <input
                  id="edit-total"
                  type="number"
                  min="1"
                  step="1"
                  value={editTotalPayments}
                  onChange={(e) => setEditTotalPayments(e.target.value)}
                  placeholder="e.g. 12"
                  className="w-full rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100
                             placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={patchSubMutation.isPending}
                />
              </div>
              {editError && <p className="text-red-400 text-sm">{editError}</p>}
              <div className="flex gap-3 justify-end mt-1">
                <button
                  type="button"
                  onClick={() => setEditingSub(null)}
                  className="px-4 py-2 rounded-md bg-gray-600 hover:bg-gray-500 text-white text-sm transition-colors"
                  disabled={patchSubMutation.isPending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium
                             transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={patchSubMutation.isPending}
                >
                  {patchSubMutation.isPending ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── BillingPanel ────────────────────────────────────────────────────────────

const BILLING_TABS = [
  { id: "invoices", label: "Invoices" },
  { id: "subscriptions", label: "Subscriptions" },
];

export default function BillingPanel({ showToast }) {
  const [activeTab, setActiveTab] = useState("invoices");

  return (
    <div>
      {/* Sub-tabs */}
      <div className="flex border-b border-gray-700 mb-6">
        {BILLING_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "invoices" && <InvoicesTab showToast={showToast} />}
      {activeTab === "subscriptions" && <SubscriptionsTab showToast={showToast} />}
    </div>
  );
}
