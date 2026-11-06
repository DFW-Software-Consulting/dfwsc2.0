import { useCallback, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import AddClientModal from "./AddClientModal";
import AdminLogin from "./AdminLogin";
import ClientList from "./ClientList";
import GroupPanel from "./GroupPanel";
import PaymentReports from "./PaymentReports";
import SettingsPanel from "./SettingsPanel";
import Button from "./shared/Button";
import Toast from "./Toast";

const TABS = [
  { id: "clients", label: "Accounts" },
  { id: "groups", label: "Companies" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
];

export default function AdminDashboard() {
  const { isLoggedIn, logout } = useAuth();

  const [activeTab, setActiveTab] = useState("clients");
  const [toast, setToast] = useState({ show: false, message: "", type: "" });
  const [showAddClient, setShowAddClient] = useState(false);

  const showToast = useCallback((message, type = "info") => {
    setToast({ show: true, message, type });
  }, []);

  const hideToast = useCallback(() => {
    setToast({ show: false, message: "", type: "" });
  }, []);

  const handleLogout = useCallback(() => {
    logout();
    setActiveTab("clients");
  }, [logout]);

  if (!isLoggedIn) {
    return (
      <>
        <AdminLogin showToast={showToast} />
        <Toast show={toast.show} message={toast.message} type={toast.type} onClose={hideToast} />
      </>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-lg font-semibold text-fg">Welcome, Admin!</h3>
        <Button variant="secondary" onClick={handleLogout}>
          Logout
        </Button>
      </div>

      {/* Scrolls sideways on narrow screens instead of widening the page; scroll-shade-x
          shades whichever edge has more tabs and shows nothing when they all fit. */}
      <nav
        aria-label="Admin sections"
        className="scroll-shade-x overflow-x-auto scroll-px-8 mb-6"
        data-testid="admin-tabs"
      >
        <div className="flex w-max min-w-full border-b border-line">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex shrink-0 items-center whitespace-nowrap px-4 py-2 max-md:min-h-11 pointer-coarse:min-h-11 text-sm font-medium transition-colors border-b-2 -mb-px focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-focus ${
                activeTab === tab.id
                  ? "border-brand-500 text-brand-700 dark:text-brand-300"
                  : "border-transparent text-fg-muted hover:text-fg"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      {activeTab === "clients" && (
        <>
          <div className="flex justify-end mb-4">
            <Button onClick={() => setShowAddClient(true)}>Add Client</Button>
          </div>
          <ClientList showToast={showToast} workspace="client_portal" />
        </>
      )}

      {showAddClient && (
        <AddClientModal
          onClose={() => setShowAddClient(false)}
          showToast={showToast}
          workspace="client_portal"
        />
      )}

      {activeTab === "groups" && <GroupPanel showToast={showToast} workspace="client_portal" />}

      {activeTab === "reports" && (
        <PaymentReports showToast={showToast} workspace="client_portal" />
      )}

      {activeTab === "settings" && <SettingsPanel showToast={showToast} />}

      <Toast show={toast.show} message={toast.message} type={toast.type} onClose={hideToast} />
    </div>
  );
}
