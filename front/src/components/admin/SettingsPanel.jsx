import { useState } from "react";
import { useSettings, useUpdateSetting } from "../../hooks/useSettings";
import ErrorMessage from "./shared/ErrorMessage";
import LoadingSpinner from "./shared/LoadingSpinner";

export default function SettingsPanel({ showToast }) {
  const { data: settings, isLoading, isError, error } = useSettings();
  const updateSettingMutation = useUpdateSetting();

  const [formValues, setFormValues] = useState({});

  const getValueForSave = (key, fallback) => formValues[key] ?? fallback;

  const handleUpdate = async (key, value) => {
    try {
      await updateSettingMutation.mutateAsync({ key, value });
      showToast?.("Setting updated successfully.", "success");
    } catch (err) {
      showToast?.(`Error updating setting: ${err.message}`, "error");
    }
  };

  if (isLoading) return <LoadingSpinner message="Loading settings..." />;
  if (isError) return <ErrorMessage message={error.message} />;

  return (
    <div className="space-y-6">
      <div className="p-4 bg-gray-700/50 rounded-lg border border-gray-600">
        <h4 className="text-md font-semibold text-white mb-4 flex items-center gap-2">
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
            aria-label="Settings"
          >
            <title>Settings Icon</title>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Platform Settings
        </h4>

        <div className="space-y-4">
          {/* Default Fee Cents */}
          <div>
            <label htmlFor="default_fee_cents" className="block text-sm text-gray-300 mb-1">
              Global Default Fee (Fixed Cents)
            </label>
            <div className="flex gap-2">
              <input
                id="default_fee_cents"
                type="number"
                value={formValues.default_fee_cents ?? settings.defaultFeeCents}
                onChange={(e) =>
                  setFormValues({ ...formValues, default_fee_cents: e.target.value })
                }
                className="flex-1 rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100"
              />
              <button
                type="button"
                onClick={() =>
                  handleUpdate(
                    "default_fee_cents",
                    getValueForSave("default_fee_cents", settings.defaultFeeCents)
                  )
                }
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm transition-colors"
              >
                Save
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Applied to transactions that don't have a specific client or group fee set.
            </p>
          </div>

          {/* Default Fee Percent */}
          <div>
            <label htmlFor="default_fee_percent" className="block text-sm text-gray-300 mb-1">
              Global Default Fee (%) (Optional)
            </label>
            <div className="flex gap-2">
              <input
                id="default_fee_percent"
                type="number"
                step="0.1"
                value={formValues.default_fee_percent ?? settings.defaultFeePercent ?? ""}
                onChange={(e) =>
                  setFormValues({ ...formValues, default_fee_percent: e.target.value })
                }
                className="flex-1 rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100"
                placeholder="e.g. 2.9"
              />
              <button
                type="button"
                onClick={() =>
                  handleUpdate(
                    "default_fee_percent",
                    getValueForSave("default_fee_percent", settings.defaultFeePercent ?? "")
                  )
                }
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm transition-colors"
              >
                Save
              </button>
            </div>
          </div>

          <hr className="border-gray-700" />

          {/* Company Name */}
          <div>
            <label htmlFor="company_name" className="block text-sm text-gray-300 mb-1">
              Platform Company Name
            </label>
            <div className="flex gap-2">
              <input
                id="company_name"
                type="text"
                value={formValues.company_name ?? settings.companyName}
                onChange={(e) => setFormValues({ ...formValues, company_name: e.target.value })}
                className="flex-1 rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100"
              />
              <button
                type="button"
                onClick={() =>
                  handleUpdate(
                    "company_name",
                    getValueForSave("company_name", settings.companyName)
                  )
                }
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm transition-colors"
              >
                Save
              </button>
            </div>
          </div>

          {/* Contact Email */}
          <div>
            <label htmlFor="contact_email" className="block text-sm text-gray-300 mb-1">
              Platform Contact Email
            </label>
            <div className="flex gap-2">
              <input
                id="contact_email"
                type="email"
                value={formValues.contact_email ?? settings.contactEmail}
                onChange={(e) => setFormValues({ ...formValues, contact_email: e.target.value })}
                className="flex-1 rounded-md border border-gray-600 bg-gray-900/50 px-3 py-2 text-gray-100"
              />
              <button
                type="button"
                onClick={() =>
                  handleUpdate(
                    "contact_email",
                    getValueForSave("contact_email", settings.contactEmail)
                  )
                }
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm transition-colors"
              >
                Save
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Contact email shown to customers for support inquiries.
            </p>
          </div>

          <hr className="border-gray-700" />

          {/* Email Configuration - Read Only */}
          <div>
            <h5 className="text-sm font-medium text-gray-200 mb-3 flex items-center gap-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4 text-gray-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
              Email Configuration
            </h5>

            <div className="bg-gray-800/50 rounded-md p-3 border border-gray-600/50">
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-xs text-gray-400 mb-0.5">Sender Email</label>
                  <span className="text-sm text-gray-200 font-mono">
                    {settings.smtpFrom || "Not configured"}
                  </span>
                </div>
                <span className="text-xs text-gray-500 bg-gray-700/50 px-2 py-1 rounded">
                  Read-only
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Configured via environment variables. Contact your administrator to change SMTP settings.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
